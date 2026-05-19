import { useQuery } from "@tanstack/react-query";

export function useCkbTipHeader() {
  return useQuery({
    queryKey: ["ckb", "tip-header"],
    queryFn: () => window.ckb.tipHeader(),
    refetchInterval: 6_000,
  });
}

export function useCkbStatus() {
  return useQuery({
    queryKey: ["ckb", "status"],
    queryFn: () => window.ckb.status(),
    refetchInterval: 10_000,
  });
}
