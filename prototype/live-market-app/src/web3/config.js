import { defineChain } from "viem";

export const OFFICIAL_AMOY_USDC = "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582";
export const AMOY_CHAIN_ID = 80002;
export const AMOY_RPC_URL = import.meta.env.VITE_AMOY_RPC_URL || "https://polygon-amoy.drpc.org";
export const MARKET_ADDRESS = import.meta.env.VITE_MARKET_ADDRESS || "";
export const FACTORY_ADDRESS = import.meta.env.VITE_FACTORY_ADDRESS || "";
export const USDC_ADDRESS = import.meta.env.VITE_USDC_ADDRESS || OFFICIAL_AMOY_USDC;
export const EXPLORER_URL = "https://amoy.polygonscan.com";
export const CIRCLE_FAUCET_URL = "https://faucet.circle.com/";

export const polygonAmoy = defineChain({
  id: AMOY_CHAIN_ID,
  name: "Polygon Amoy",
  nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
  rpcUrls: { default: { http: [AMOY_RPC_URL] } },
  blockExplorers: { default: { name: "PolygonScan", url: EXPLORER_URL } },
  testnet: true,
});

export function hasMarketDeployment(address) {
  return /^0x[a-fA-F0-9]{40}$/.test(address || "") && !/^0x0{40}$/.test(address || "");
}

export function hasTestnetDeployment() {
  return hasMarketDeployment(MARKET_ADDRESS);
}
