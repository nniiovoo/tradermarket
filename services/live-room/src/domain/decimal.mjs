// Exact decimal arithmetic on strings — floats are banned from settlement math.
// Scale-6 fixed point (USDC precision) via BigInt.

const SCALE = 6n;
const ONE = 10n ** SCALE;

export function toScaled(value) {
  if (typeof value === "number") value = String(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) throw new Error(`not a decimal string: ${value}`);
  const [, sign, whole, frac = ""] = match;
  if (frac.length > Number(SCALE)) {
    // Truncate beyond scale deterministically (toward zero).
    return applySign(sign, BigInt(whole) * ONE + BigInt(frac.slice(0, Number(SCALE)).padEnd(Number(SCALE), "0")));
  }
  return applySign(sign, BigInt(whole) * ONE + BigInt(frac.padEnd(Number(SCALE), "0")));
}

function applySign(sign, magnitude) {
  return sign === "-" ? -magnitude : magnitude;
}

export function fromScaled(scaled) {
  const negative = scaled < 0n;
  const magnitude = negative ? -scaled : scaled;
  const whole = magnitude / ONE;
  const frac = (magnitude % ONE).toString().padStart(Number(SCALE), "0").replace(/0+$/, "");
  return (negative ? "-" : "") + whole.toString() + (frac ? "." + frac : "");
}

export function addDecimal(a, b) {
  return fromScaled(toScaled(a) + toScaled(b));
}

export function compareDecimal(a, b) {
  const aScaled = toScaled(a);
  const bScaled = toScaled(b);
  return aScaled < bScaled ? -1 : aScaled > bScaled ? 1 : 0;
}

/** (a / b) * 100 with scale-6 truncation — used for return_pct. */
export function percentOf(a, b) {
  const bScaled = toScaled(b);
  if (bScaled === 0n) throw new Error("division by zero baseline");
  return fromScaled((toScaled(a) * 100n * ONE) / bScaled);
}
