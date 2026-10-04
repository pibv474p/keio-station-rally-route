import { trainDiagramTsv } from "./train_diagram_tsv.ts";
import type { Exporter } from "./types.ts";

// OuDia(.oud2) / 自作 SVG はここに追加する
export const exporters: Record<string, Exporter> = {
  [trainDiagramTsv.name]: trainDiagramTsv,
};
