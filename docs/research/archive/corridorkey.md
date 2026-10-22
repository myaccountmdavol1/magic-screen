> Archived: CorridorKey was dropped (needs NVIDIA server, license forbids bundling weights, cannot run in real time on iPad).

# CorridorKey 2.0: findings for the kindergarten green-screen app (web + iPad)

**Bottom line:** The repo is real and under the exact name given: https://github.com/nikopueringer/CorridorKey2.0 (branch `master`). It is a large video-matting model, about 1.2B parameters counting its helper models. It runs offline on one clip at a time and **requires an NVIDIA CUDA GPU**. It cannot run in a browser or on an iPad, and it cannot run in real time. The app needs a fast chroma key in the browser for live preview, plus an optional server running CorridorKey 2.0 for a high-quality final render.

I shallow-cloned the repo to `/private/tmp/claude-501/-Users-md-Green-Screen-2/727545c3-c535-41ef-933d-42d65e406914/scratchpad/ck/repo` to read the source. None of its code was executed. I did not use web search; everything below comes from the gh CLI, the GitHub API, the Hugging Face API and the source files.

Related repos for context:
- **v1:** https://github.com/nikopueringer/CorridorKey. Uses a Hiera backbone and needs an RGB frame plus a coarse alpha hint. Checkpoint is about 300 MB (`CorridorKey_v1.0.pth`).
- **v1 ports:** an MLX port for Apple Silicon (https://github.com/nikopueringer/corridorkey-mlx) and an OpenVINO export (https://github.com/daniil-lyakhov/CorridorKeyOpenVINO).

---

## 1. What it is

**Purpose.** It is a two-stage transformer that pulls a person off a green or blue screen in video. It predicts a soft alpha (transparency) channel and the true foreground color with the green removed, including motion blur and hair. From `corridorkey/model.py`:

```python
class CorridorKeyV3(nn.Module):
    """Transformer-native two-stage video matting model.
    Stage 1 produces a /16 baton (d=512) plus an auxiliary /2 prediction ...
    Stage 2 refines the baton + raw RGB to a /1 alpha+FG output via pure-transformer Swin-2D + depatchify.
    Temporal mixing lives primarily in stage 1: full spatiotemporal attention at /64, Swin-3D at /16 ...
```

`corridorkey/__init__.py` publishes it as `CorridorKeyV2(CorridorKeyV3)`.

**Three frozen helper models.** These are not in the repo; they are downloaded into `vfms/`:
- C-RADIOv4-SO400M (NVIDIA Open Model License)
- MoGe-2 ViT-B (MIT)
- RVM small (Google DeepMind; code Apache 2.0, weights CC-BY 4.0)

**Size.** I read the safetensors header for `corridorkey_v2.safetensors`: **665.4M parameters, all F32**. The helper models add roughly 0.5B more.

**Forward contract** (`model.py` docstring):
```
rgb:       (B, T, 3, H, W)   signed asinh encoded scene-linear RGB
hint:      (B, T, 1, H, W)   in [0, 1]
rgb_cradio:(B, T, 3, H/4, W/4);  rgb_moge: (B, T, 3, 7H/32, 7W/32)
H and W must be multiples of 64
Output: 'alpha' (B,T,1,H,W), 'fg' (B,T,3,H,W) asinh encoded, plus aux /2 preds
```

**Does it need a hint mask? No, the hint is optional.** There are three modes:
- **No hint** (default): "The model decides what the foreground subject is."
- **First-frame hint:** `--hint_first_frame matte.png`, where white means subject and black means background. The model carries its own predictions forward through overlapping time windows ("Hann carry").
- **Full hint video:** `--hint_video`, optionally with `--no_carry_hint`.
- `--hint_quality` sets how much the model trusts the hint: 0.95 for an artist matte, 0.75 for a rough automatic one, 0.5 or less for a scribble.

This differs from v1, which required a coarse alpha hint.

**Outputs:** `alpha` (matte), `fg` (straight foreground RGB), `checker` (comp over a checkerboard, despilled) and `cutout` (straight RGBA, ProRes 4444). Video outputs are ffmpeg previews (x264 `yuv444p10le`, CRF 12). `--output_format exr` writes OpenEXR sequences instead. `--despill_strength` defaults to 0.5. There is no green/blue selector in v2.

**Resolution:** native resolution is always kept. Frames are reflect-padded to a multiple of 128 (`shape_quantum: int = 128` in `InferenceConfig`) and cropped back. `--model_scale` can downscale before inference.

**License.** The custom "Corridor Key Licence v2.0" (`LICENSE`) is CC BY-NC-SA 4.0 plus extra terms:
- **1a/1b:** any lawful use is allowed, including commercial projects, and the output images/video belong to the user.
- **2a:** no repackaging, reselling, or charging for access to the code or weights.
- **2b:** no paid API or inference service. This covers paywalls, subscriptions and usage billing.
- **2c:** derivatives you release must be free to the public. Donations and pay-what-you-want are allowed.
- **2d:** a commercial software package that integrates it needs a written agreement (contact@corridordigital.com).
- **3:** organizations with more than US$20M revenue must buy a plugin seat for each user.
- **4:** the name "CorridorKey" must appear in attribution, and forks must keep the name prominently.
- **5:** share-alike.

What this means for a school:
- A **free**, non-commercial kindergarten app with a self-hosted render server looks compatible. It must show a visible "Powered by CorridorKey" credit and be released under the same license.
- A **paid** App Store app, or charging for the server step, would break 2a/2b unless Corridor Digital gives permission.
- A large school district could exceed the $20M revenue threshold in section 3.
- The C-RADIO NVIDIA Open Model License also applies.
- **This is my reading, not legal advice.** The user should confirm with Corridor Digital before shipping.

## 2. Inference requirements

**Framework:** PyTorch, tested with `torch==2.9.1` and `torchvision==0.24.1` (cu128 wheel index). From `requirements.txt`:
- numpy<2, opencv-python, transformers>=4.57,<5, timm, safetensors, huggingface-hub, einops, scipy, pillow, tqdm
- `utils3d @ git+https://github.com/EasternJournalist/utils3d.git@83bfa5b...`

ffmpeg must be on PATH.

**CUDA is hard-required.** From `infer.py`:
```python
if not torch.cuda.is_available():
    raise RuntimeError("CorridorKey v2 runtime requires a CUDA GPU.")
```
`runtime.py` also hardcodes `torch.autocast("cuda", dtype=torch.bfloat16)`, `.cuda()` and `torch.cuda.mem_get_info()`. There is no MPS (Apple GPU) or CPU path, so it will not run on a Mac or an iPad as shipped.

**VRAM:** the README says "RTX 30-series or newer with at least 4 GB of VRAM for footage up to 1440p, or 6 GB for 4K". By default it picks the time-window size from free GPU memory (`apply_auto_vram`). From `_VRAM_PEAK_GB` in `runtime.py`:
- Normal mode at 1 MP: about 6.2 GB with an 8-frame window, about 12.9 GB with 80 frames.
- Low-VRAM mode at 1 MP: about 2.7 GB with a single frame.
- At 1080p, a 16 GB card gets a 48/24 low-VRAM window.

**Speed:** the repo publishes **no fps or seconds-per-frame numbers**. The only remark is that `--stage2_batch` 1 "was no slower than larger batches". Given the size (about 1.2B parameters, four networks per frame, time windows up to 80 frames), my estimate is roughly seconds per 1080p frame on a consumer RTX card. That is clearly offline, not real time. This estimate is not measured.

**Weights.** `scripts/download_weights.py` downloads about 5 GB in total:

| File | Source | Size |
|---|---|---|
| `corridorkey_v2.safetensors`, `foundation_stats.safetensors` → `weights/` | `nikopueringer/CorridorKey2.0` on Hugging Face (https://huggingface.co/nikopueringer/CorridorKey2.0) | 2,661,698,720 bytes (2.66 GB) and 18.9 KB |
| C-RADIO → `vfms/cradio/C-RADIOv4-SO400M/` | `nvidia/C-RADIOv4-SO400M` at revision `c0457f5d…` | `model.safetensors` 1.72 GB |
| MoGe → `vfms/moge/model.pt` | `Ruicheng/moge-2-vitb-normal` at revision `ca5f0e07…` | not checked |
| RVM → `vfms/rvm/pretrain_rvm_small16_256_204031069.npz` | https://storage.googleapis.com/representations4d/checkpoints/pretrain_rvm_small16_256_204031069.npz (MD5-checked) | not checked |

## 3. ONNX / CoreML / web export and real-time feasibility

**v2 has no official export.** The repo has no ONNX, CoreML, TensorRT or web export. The only conversion script is `scripts/convert_to_safetensors.py`, which converts `.pt` to safetensors.

**Third-party ports, mostly v1:**
- **CorridorKey-Runtime** (https://github.com/alexandremendoncaalvaro/CorridorKey-Runtime): the official plugin runtime. It uses ONNX Runtime with TensorRT-RTX on Windows and MLX on Apple Silicon. Its README talks about regenerating `.onnx` files from the checkpoint, so an export does exist inside that project. It targets desktop apps (Resolve, Nuke) and the paid plugin.
- **CorridorKeyWeb.github.io:** a 37 KB `index.html` that says it supports "CorridorKey 2.0". In its code it builds a v1 "GreenFormer" graph (`buildGreenFormer`, `decoder`, `refiner`) in onnxruntime-web 1.22.0 from safetensors. That is **v1 architecture**. It has no C-RADIO, MoGe, RVM or Stage1/Stage2, so it cannot correctly run v2 weights. It does show that a **v1-sized** model in the browser is feasible on desktop Chrome with WebGPU.
- **v1 OpenVINO and MLX ports** exist (links at the top).
- **qshiqshi/corridorkey-obs-filter** claims "real-time" but uses **v1** and needs a GPU with 24 GB or more of VRAM, or an M-series Mac.

**Could v2 be exported?** In theory, piece by piece: C-RADIO, MoGe, RVM, Stage1 and Stage2 as separate graphs. In practice it is very hard:
- Custom attention (`_sdpa_with_region_ids` / `_sdpa_with_region_groups`, Swin-3D, CSwin, full 3D attention, RoPE).
- Time windows plus a recurrent RVM state.
- Around 4.4 GB of fp32 weights.
- bf16 autocast.

**In-browser or on-iPad v2: not realistic.**
- An iPad has 8–16 GB of unified memory, shared.
- Safari WebGPU has buffer and memory limits, and 4+ GB of weights would have to download to every device.
- Even desktop RTX cards run this offline.

**Real time: no.** This is an offline, clip-at-a-time tool by design ("Stage 1 runs on overlapping temporal windows ... Stage 2 then streams the final full-resolution predictions").

## 4. How to run it

**CLI** (`infer.py`):
```
python infer.py --input /path/to/input.mp4 --output_dir /path/to/output
python infer.py --input shot.mp4 --output_dir out --hint_first_frame matte.png --hint_quality 0.95 \
   --outputs alpha fg checker cutout --despill_strength 0.5
python infer.py --input /path/to/frames --frame_dir_fps 24 --output_dir out   # PNG/JPG/EXR dir (single image = 1-frame dir)
```

Other entry points:
- Guided session: `python run_interactive.py /path/to/clip.mp4`
- Drag-and-drop launchers: `CorridorKey_DRAG_CLIPS_HERE.sh` and `.bat`. They pick up `<clip>FrameHint.png` and `<clip>_AlphaHint.mp4` automatically.

Output names: `checker` writes `checker_comp_despill{NNN}`; EXR mode writes `<clip>_fg_exr/fg_000000.exr`.

**Python API** (`corridorkey/runtime.py`, exactly as `infer.py` uses it):
```python
from corridorkey.runtime import InferenceConfig, RuntimePaths, WriterConfig, load_model, run_inference
paths = RuntimePaths.from_package(package_root, None)     # weights/corridorkey_v2.safetensors, vfms/...
model = load_model(paths, device="cuda")                  # def load_model(paths: RuntimePaths, device: str = "cuda") -> CorridorKeyV3
infer_cfg = InferenceConfig(hann_chunk=80, hann_stride=40, auto_vram=True, outputs={"alpha","fg","cutout"},
                            despill_strength=0.5, ...)
writer_cfg = WriterConfig(ffmpeg_bin="ffmpeg", codec="libx264", crf=12, preset="medium",
                          pix_fmt="yuv444p10le", bitrate=None, threads=2)
run_inference(model, input_path, output_dir, infer_cfg, writer_cfg,
              initial_hint_path=None, hint_video_path=None)
# def run_inference(model, input_path: str, output_dir: str, cfg: InferenceConfig,
#                   writer_cfg: WriterConfig, *, initial_hint_path: str | None, hint_video_path: str | None)
```

`infer.py` sets `HF_HUB_OFFLINE=1` and `TRANSFORMERS_OFFLINE=1`, and the runtime adds `third_party/MoGe` to `sys.path`. Load the model **once** and keep it in memory; loading takes several GB of RAM and VRAM. The API only works with files on disk (video file or frame folder in, video or EXR files out). There is no function that takes a numpy array and returns a matte.

## 5. Recommended architecture for the kid app

**Tier A: live, on the device (always available, required).**
- Use a WebGL2/WebGPU chroma-key fragment shader on `getUserMedia` camera frames or imported video. It should key in YCbCr/HSV distance with smoothstep softness and despill (`g = min(g, max(r,b))`), and composite over a background canvas.
- It runs at 60 fps on iPad Safari and phones, works offline and needs no download.
- Give kids **no sliders**: tap-to-sample the screen color, plus an "auto" default.
- Record the composite with `canvas.captureStream()` + `MediaRecorder` (Safari: mp4/H.264).
- Ship it as a PWA so it works on web and iPad from one codebase. Wrap it with Capacitor if an App Store build is wanted.
- Optional upgrade if the green screen is uneven: MediaPipe Selfie Segmentation (tasks-vision, WASM/WebGL) as a person mask, combined with chroma for the edges. This is v1-class quality, still real time, and needs no server.

**Tier B: "Make it Magic" final render (optional, needs a server).**
- Python FastAPI worker on an NVIDIA box (RTX 3060 12 GB or better; for example a school machine or a GPU cloud instance).
- `POST /jobs` takes a short clip of at most about 10 s, capped at 720p by downscaling on the client or with `model_scale`, plus an optional first-frame hint PNG. Use the device's chroma matte as the `hint_first_frame`, with `hint_quality=0.75`.
- The worker writes to a temp dir and calls `run_inference(..., outputs={"alpha","fg"} or {"cutout"})` with a model loaded once at startup.
- Run one GPU job at a time behind a queue (RQ, Celery or asyncio queue). `GET /jobs/{id}` returns progress; on completion return a ProRes 4444 `cutout`, or alpha + fg mp4s that the client composites over the chosen background in WebGL.
- Show a playful "magic is happening" animation while kids wait, since this takes minutes, not seconds.
- To stay within the license: free to use, no paywall in front of the render, a visible "Powered by CorridorKey (Corridor Digital)" credit, same license on any released derivative, and no student footage kept after the render (COPPA/FERPA).

**Fallback when no server is reachable:**
- Hide or disable "Make it Magic" by feature-flagging on a `/health` check.
- Final export uses the Tier A chroma key (optionally improved with the MediaPipe mask), rendered at full resolution offline with temporal matte smoothing. The app stays fully usable on its own.

**Do not:**
- Try to run CorridorKey 2.0 in the browser or on the iPad.
- Embed or redistribute the about 5 GB of weights in the app.
- Trust the CorridorKeyWeb "2.0" page: it is v1 architecture.