"use client"

import * as React from "react"
import { DEFAULT_TRANSFORM_WIDTH } from "@/components/ui/image-helpers"

export function useResponsiveImage(
  { parsed, fittingType = "cover", focalPoint, quality = 80, onLoad, onSourceChange },
  forwardedRef
) {
  const wrapperRef = React.useRef(null)
  const imgNodeRef = React.useRef(null)
  const [loaded, setLoaded] = React.useState(false)
  const [width, setWidth] = React.useState(DEFAULT_TRANSFORM_WIDTH)

  const imgRef = React.useCallback(
    (node) => {
      imgNodeRef.current = node
      if (typeof forwardedRef === "function") forwardedRef(node)
      else if (forwardedRef) forwardedRef.current = node
    },
    [forwardedRef]
  )

  React.useEffect(() => {
    if (!parsed) {
      setLoaded(false)
      return
    }
    const element = wrapperRef.current
    if (!element) return

    const updateWidth = () => {
      const next = Math.max(
        1,
        Math.round(element.getBoundingClientRect().width || DEFAULT_TRANSFORM_WIDTH)
      )
      setWidth((previous) => (previous === next ? previous : next))
    }

    updateWidth()
    if (typeof ResizeObserver === "undefined") return undefined
    const observer = new ResizeObserver(updateWidth)
    observer.observe(element)
    return () => observer.disconnect()
  }, [parsed])

  React.useEffect(() => {
    setLoaded(false)
    if (parsed && onSourceChange) onSourceChange(parsed.baseUrl)
  }, [parsed, onSourceChange])

  const options = React.useMemo(() => {
    if (!parsed) return null
    return {
      width,
      crop: fittingType === "fit" ? "fit" : "fill",
      focalPoint,
      quality,
    }
  }, [parsed, width, fittingType, focalPoint, quality])

  const handleLoad = React.useCallback(
    (event) => {
      setLoaded(true)
      onLoad?.(event)
    },
    [onLoad]
  )

  return { wrapperRef, imgRef, loaded, options, handleLoad }
}
