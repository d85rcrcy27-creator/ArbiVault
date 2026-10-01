const db = globalThis.__APP_DB__ || { auth:{ isAuthenticated: async()=>false, me: async()=>null }, entities:new Proxy({}, { get:()=>({ filter:async()=>[], get:async()=>null, create:async()=>({}), update:async()=>({}), delete:async()=>({}) }) }), integrations:{ Core:{ UploadFile:async()=>({ file_url:'' }) } } };

import * as React from "react"
import { ResponsiveImage } from "./responsive-image"
import {
  getOriginalImageUrl,
  IMAGE_LOAD_MODE,
  nextImageLoadMode,
  parseWixMediaUrl,
} from "./image-helpers"

const FALLBACK_IMAGE_URL =
  "https://static.wixstatic.com/media/12d367_4f26ccd17f8f4e3a8958306ea08c2332~mv2.png"

/**
 * Image with built-in Wix Media Platform support: canonical public images on
 * media.db.com and static.wixstatic.com/media are resized to the rendered
 * container per device pixel ratio and re-encoded to WebP; `fittingType="fill"`
 * crops server-side, optionally anchored at a focal point. Other URLs render
 * as a plain <img>. Failed transforms retry the original URL; only a broken
