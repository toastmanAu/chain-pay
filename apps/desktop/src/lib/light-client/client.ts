import { LightClientHost } from "./host";

let instance: LightClientHost | null = null;

export function lightClient(): LightClientHost {
  if (!instance) instance = new LightClientHost();
  return instance;
}
