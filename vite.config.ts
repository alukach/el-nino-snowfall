import { defineConfig } from "vite";

// BASE_PATH is set by the Pages workflow to "/<repo>/"; local dev serves from "/".
export default defineConfig({ base: process.env.BASE_PATH ?? "/" });
