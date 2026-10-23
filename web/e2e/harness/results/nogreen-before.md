# Keyer harness: nogreen-before

2026-10-22T19:56:58.866Z · ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Pro, Unspecified Version) · 640x360 · warmup 10 frames · helper cadence 2

Lower is better for every column. Units: SAD /1000 px; SAD edge /1000 px, GT edge band; MSE x1e3; Grad /1000; Conn /1000; FP bg x1e3; FN fg x1e3; Flicker x1e3; Spill x1e3; Unmix ΔE CIE76.

## Magic Helper: off@selfie:stretch

| scenario | mode | SAD | SAD edge | MSE | Grad | Conn | FP bg | FN fg | Flicker | Spill | Unmix ΔE | ML mask IoU |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| clean | chroma | 1.22 | 1.15 | 1.964 | 2.66 | 1.18 | 1.39 | 8.75 | 0.75 | 0.23 | 16.31 | – |
| uneven-light | chroma | 1.11 | 1.05 | 1.719 | 2.25 | 1.08 | 1.03 | 8.70 | 0.58 | 0.19 | 15.32 | – |
| shadow-wrinkles | chroma | 1.17 | 1.11 | 1.870 | 2.54 | 1.11 | 1.35 | 7.93 | 0.71 | 0.17 | 15.07 | – |
| hair-spill | chroma | 1.78 | 1.70 | 3.001 | 3.12 | 1.76 | 1.19 | 6.36 | 0.55 | 0.55 | 15.56 | – |
| motion-blur | chroma | 1.50 | 1.43 | 2.496 | 3.68 | 1.49 | 1.06 | 8.66 | 0.63 | 0.20 | 14.46 | – |
| noise | chroma | 1.22 | 1.15 | 1.954 | 2.63 | 1.17 | 1.38 | 8.88 | 1.03 | 0.25 | 16.31 | – |
| compression | chroma | 1.82 | 1.75 | 3.952 | 6.76 | 1.73 | 4.22 | 9.98 | 1.68 | 1.27 | 16.19 | – |
| awb-drift | chroma | 1.19 | 1.13 | 1.894 | 2.61 | 1.15 | 1.35 | 8.24 | 0.69 | 0.17 | 16.75 | – |
| flicker | chroma | 1.22 | 1.15 | 1.978 | 2.69 | 1.18 | 1.40 | 8.72 | 0.73 | 0.23 | 16.53 | – |
| green-shirt | chroma | 25.45 | 4.56 | 108.426 | 13.37 | 25.42 | 0.55 | 647.87 | 0.61 | 0.17 | 18.00 | – |
| yellow-shirt | chroma | 0.88 | 0.87 | 1.517 | 1.94 | 0.86 | 1.18 | 2.11 | 0.60 | 0.32 | 13.16 | – |
| blue-screen | chroma | 1.15 | 1.11 | 2.012 | 2.69 | 0.99 | 1.62 | 6.20 | 0.88 | 0.35 | 17.96 | – |
| specks | chroma | 2.72 | 1.24 | 7.990 | 10.80 | 2.66 | 9.28 | 8.72 | 0.84 | 0.22 | 16.56 | – |
| classroom | segment | 21.45 | 2.87 | 84.824 | 7.37 | 21.74 | 1.14 | 564.89 | 5.97 | – | 11.84 | 0.442 |
| webcam-beige | segment | 6.91 | 1.84 | 20.114 | 3.57 | 6.86 | 3.63 | 96.46 | 9.70 | – | 7.40 | 0.916 |

## Magic Helper: on@selfie:stretch

| scenario | mode | SAD | SAD edge | MSE | Grad | Conn | FP bg | FN fg | Flicker | Spill | Unmix ΔE | ML mask IoU |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| clean | chroma | 1.22 | 1.15 | 1.964 | 2.66 | 1.18 | 1.39 | 8.75 | 0.75 | 0.23 | 16.31 | 0.794 |
| uneven-light | chroma | 1.11 | 1.05 | 1.719 | 2.25 | 1.08 | 1.03 | 8.70 | 0.58 | 0.19 | 15.32 | 0.844 |
| shadow-wrinkles | chroma | 1.17 | 1.11 | 1.870 | 2.54 | 1.11 | 1.35 | 7.93 | 0.71 | 0.17 | 15.07 | 0.788 |
| hair-spill | chroma | 1.78 | 1.70 | 3.001 | 3.12 | 1.76 | 1.19 | 6.36 | 0.55 | 0.55 | 15.56 | 0.752 |
| motion-blur | chroma | 1.50 | 1.43 | 2.496 | 3.68 | 1.49 | 1.06 | 8.66 | 0.63 | 0.20 | 14.46 | 0.751 |
| noise | chroma | 1.22 | 1.15 | 1.956 | 2.63 | 1.18 | 1.38 | 8.95 | 1.04 | 0.25 | 16.31 | 0.715 |
| compression | chroma | 1.82 | 1.75 | 3.952 | 6.76 | 1.73 | 4.22 | 9.98 | 1.68 | 1.27 | 16.19 | 0.764 |
| awb-drift | chroma | 1.19 | 1.13 | 1.894 | 2.61 | 1.15 | 1.35 | 8.24 | 0.69 | 0.17 | 16.75 | 0.779 |
| flicker | chroma | 1.22 | 1.15 | 1.978 | 2.69 | 1.18 | 1.40 | 8.72 | 0.73 | 0.23 | 16.53 | 0.799 |
| green-shirt | chroma | 25.45 | 4.56 | 108.426 | 13.37 | 25.42 | 0.55 | 647.87 | 0.61 | 0.17 | 18.00 | 0.351 |
| yellow-shirt | chroma | 1.10 | 0.90 | 2.134 | 2.17 | 1.10 | 1.17 | 8.11 | 0.94 | 0.31 | 13.24 | 0.589 |
| blue-screen | chroma | 2.99 | 1.38 | 8.916 | 4.44 | 2.91 | 1.55 | 54.83 | 2.09 | 0.34 | 17.90 | 0.474 |
| specks | chroma | 1.95 | 1.40 | 4.644 | 5.56 | 1.92 | 3.23 | 18.84 | 1.34 | 0.22 | 16.51 | 0.550 |

## render() cost

cpu = main-thread time inside render(); gpu = timer-query GPU time of the frame; sync = render() + 1 px readPixels round trip (upper bound, includes readback latency).

| scenario | helper | stage | tier | cpu median ms | cpu p90 ms | gpu median ms | gpu p90 ms | sync median ms | sync p90 ms |
|---|---|---|---|---:|---:|---:|---:|---:|---:|
| clean | off | 1280x720 | webgl-full | 0.180 | 0.275 | 0.767 | 0.863 | 2.48 | 2.94 |
| clean | synth | 1280x720 | webgl-full | 0.180 | 0.285 | 0.907 | 1.025 | 2.72 | 3.36 |
| webcam-beige | off | 1280x720 | webgl-full | 0.185 | 0.280 | 0.710 | 0.854 | 2.58 | 3.01 |
