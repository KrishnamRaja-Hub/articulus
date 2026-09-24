import Nav from './sections/Nav'
import Hero from './sections/Hero'
import Trap from './sections/Trap'
import Stories from './sections/Stories'
import Planner from './sections/Planner'
import Footer from './sections/Footer'
import ErrorBoundary from './ui/ErrorBoundary'

// each section has its own boundary: a crash in one (a bad agreement) never blanks the site (TESTER2_REPORT M-8)
export default function App() {
  return (
    <main className="w-full max-w-full overflow-x-hidden">
      <ErrorBoundary><Nav /></ErrorBoundary>
      <ErrorBoundary><Hero /></ErrorBoundary>
      <ErrorBoundary><Trap /></ErrorBoundary>
      <ErrorBoundary><Stories /></ErrorBoundary>
      <ErrorBoundary><Planner /></ErrorBoundary>
      <ErrorBoundary><Footer /></ErrorBoundary>
    </main>
  )
}
