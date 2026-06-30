import Link from 'next/link'

export default function HomePage() {
  return (
    <div className="space-y-16">
      {/* Hero */}
      <section className="py-12 text-center">
        <h1 className="text-4xl font-bold text-gray-900 mb-4">
          Collectible Diecast Cars &amp; Pokémon Cards
        </h1>
        <p className="text-lg text-gray-500 max-w-xl mx-auto mb-8">
          Hand-picked Hot Wheels, Matchbox, and Pokémon cards — individually listed with photos and
          condition notes.
        </p>
        <Link
          href="/browse"
          className="inline-block rounded-md bg-gray-900 px-6 py-3 text-sm font-medium text-white hover:bg-gray-700 transition-colors"
        >
          Browse Listings →
        </Link>
      </section>

      {/* How it works */}
      <section className="max-w-2xl mx-auto">
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-6 text-center">
          How it works
        </h2>
        <ol className="grid grid-cols-1 sm:grid-cols-3 gap-8">
          {[
            {
              step: '1',
              title: 'Browse & add to cart',
              description: 'Find items you want and add them to your cart.',
            },
            {
              step: '2',
              title: 'Submit a request',
              description:
                'Fill in your contact info and send an order request — no payment yet.',
            },
            {
              step: '3',
              title: 'We follow up',
              description:
                "We'll confirm availability, calculate combined shipping, and arrange payment.",
            },
          ].map((s) => (
            <li key={s.step} className="flex flex-col items-center text-center">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-900 text-white text-sm font-bold mb-3">
                {s.step}
              </span>
              <h3 className="font-semibold text-gray-900 mb-1">{s.title}</h3>
              <p className="text-sm text-gray-500">{s.description}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* Order request note */}
      <section className="max-w-2xl mx-auto rounded-md border border-gray-200 bg-gray-50 px-5 py-4 text-sm text-gray-600 text-center">
        This is an order request shop — no instant checkout. Combined shipping is available and
        calculated manually when we follow up.
      </section>
    </div>
  )
}
