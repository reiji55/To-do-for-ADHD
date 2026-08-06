import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // 同じWi-Fi内のiPhoneから開けるようにする
  },
});
