import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from './Button'
import { Panel } from './Panel'

type Props = { children: ReactNode; onReset: () => void }
type State = { failed: boolean }

/**
 * Last line of defence: a render crash (e.g. a GPU driver failure) shows a friendly
 * "go home" card instead of a blank white screen a five-year-old can't recover from.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.warn('[Magic Screen] screen crashed', error, info.componentStack)
  }

  private reset = () => {
    this.setState({ failed: false })
    this.props.onReset()
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <Panel className="crash-card">
        <h2 className="crash-title">Oops! Something got stuck.</h2>
        <p className="crash-text">Let's go back and try again.</p>
        <Button variant="primary" size="lg" icon="home" onClick={this.reset}>
          Go home
        </Button>
      </Panel>
    )
  }
}
