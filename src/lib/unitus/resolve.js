export function resolveMarket(markets, asset) {
  const wanted = asset.toLowerCase();
  const market = markets.find((item) => (
    item.symbol.toLowerCase() === wanted ||
    item.iTokenSymbol.toLowerCase() === wanted ||
    item.iToken.toLowerCase() === wanted ||
    item.underlying.toLowerCase() === wanted
  ));
  if (!market) {
    throw new Error(`Unsupported Unitus market: ${asset}`);
  }
  return market;
}
