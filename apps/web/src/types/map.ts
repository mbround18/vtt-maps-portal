export type MapSummary = {
  id: string;
  legacy_id?: string;
  name: string;
  path: string;
  thumb_url?: string;
  tags?: string[];
  about_md?: string;
  poi?: unknown;
};

export type MapPreview = {
  available: boolean;
  width?: number;
  height?: number;
  image_url?: string;
  thumb_url?: string;
  dd2vtt_download_url?: string;
};
