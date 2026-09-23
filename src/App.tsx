import Nav from './sections/Nav'
import Hero from './sections/Hero'
import Trap from './sections/Trap'
import Stories from './sections/Stories'
import Planner from './sections/Planner'
import Footer from './sections/Footer'

export default function App() {
  return (
    <main className="w-full max-w-full overflow-x-hidden">
      <Nav />
      <Hero />
      <Trap />
      <Stories />
      <Planner />
      <Footer />
    </main>
  )
}
