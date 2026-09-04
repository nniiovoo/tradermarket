import { parseUnits, formatUnits } from "viem";
const fromUsdc = (value) => parseUnits(String(value || 0), 6);
const cases = ["", "0", "25", "25.1234567", "1e-7", "1e21", "0.0000001", "1e+3", "-5", "abc", "Infinity", "1e-30", "1000000000000000000000"];
for (const c of cases) {
  const safeAmount = Number.isFinite(Number(c)) ? Math.max(0, Number(c)) : 0;
  let out;
  try { out = fromUsdc(safeAmount).toString(); } catch (e) { out = "THROW: " + e.constructor.name + " " + String(e.message).split("\n")[0]; }
  console.log(JSON.stringify(c), "-> safeAmount", safeAmount, "String()", JSON.stringify(String(safeAmount||0)), "->", out);
}
