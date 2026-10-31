export async function POST() {
  return fetch(`${process.env.PRICING_FIXTURE_URL}/control/fail-save`,{ method:'POST' });
}
