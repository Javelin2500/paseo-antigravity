import type { PluginServerContext } from "@getpaseo/plugin/server";
import { provider } from "./server/provider";
import { Usage } from "./server/usage";
export default function contribute(server: PluginServerContext) {
  server.registerUsageSource(new Usage().registration());
  server.registerProvider(provider());
  return () => {};
}
