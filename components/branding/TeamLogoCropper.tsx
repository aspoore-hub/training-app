import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal, Platform, Pressable, Text, View } from "react-native";

type TeamLogoCropperProps = {
  file: File | null;
  visible: boolean;
  saving?: boolean;
  onCancel: () => void;
  onUseOriginal: (file: File) => void | Promise<void>;
  onSaveCropped: (file: File) => void | Promise<void>;
};

type Point = { x: number; y: number };
type ImageSize = { width: number; height: number };

const PREVIEW_SIZE = 260;
const OUTPUT_SIZE = 512;
const MIN_ZOOM = 1;
const MAX_ZOOM = 3;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function extensionSafeName(name: string) {
  const base = String(name ?? "team-logo").replace(/\.[^.]+$/, "").replace(/[^a-z0-9_-]+/gi, "-");
  return `${base || "team-logo"}-cropped.png`;
}

export function TeamLogoCropper({
  file,
  visible,
  saving = false,
  onCancel,
  onUseOriginal,
  onSaveCropped,
}: TeamLogoCropperProps) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [imageSize, setImageSize] = useState<ImageSize | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const dragStartRef = useRef<{ pointer: Point; offset: Point } | null>(null);

  const displaySize = useMemo(() => {
    if (!imageSize) return { width: PREVIEW_SIZE, height: PREVIEW_SIZE };
    const baseScale = Math.max(PREVIEW_SIZE / imageSize.width, PREVIEW_SIZE / imageSize.height);
    return {
      width: imageSize.width * baseScale * zoom,
      height: imageSize.height * baseScale * zoom,
    };
  }, [imageSize, zoom]);

  const clampOffset = useCallback(
    (point: Point, nextZoom = zoom) => {
      if (!imageSize) return { x: 0, y: 0 };
      const baseScale = Math.max(PREVIEW_SIZE / imageSize.width, PREVIEW_SIZE / imageSize.height);
      const width = imageSize.width * baseScale * nextZoom;
      const height = imageSize.height * baseScale * nextZoom;
      const maxX = Math.max(0, (width - PREVIEW_SIZE) / 2);
      const maxY = Math.max(0, (height - PREVIEW_SIZE) / 2);
      return {
        x: clamp(point.x, -maxX, maxX),
        y: clamp(point.y, -maxY, maxY),
      };
    },
    [imageSize, zoom]
  );

  useEffect(() => {
    if (!visible || Platform.OS !== "web" || !file || typeof URL === "undefined" || typeof Image === "undefined") {
      return;
    }

    const nextObjectUrl = URL.createObjectURL(file);
    const img = new Image();
    imageRef.current = img;
    setObjectUrl(nextObjectUrl);
    setImageSize(null);
    setZoom(1);
    setOffset({ x: 0, y: 0 });
    setError(null);

    img.onload = () => {
      setImageSize({
        width: img.naturalWidth || img.width,
        height: img.naturalHeight || img.height,
      });
    };
    img.onerror = () => {
      setError("Could not load this image for cropping.");
    };
    img.src = nextObjectUrl;

    return () => {
      URL.revokeObjectURL(nextObjectUrl);
      if (imageRef.current === img) imageRef.current = null;
    };
  }, [file, visible]);

  useEffect(() => {
    setOffset((current) => clampOffset(current));
  }, [clampOffset]);

  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;

    const onPointerMove = (event: PointerEvent) => {
      if (!dragStartRef.current) return;
      event.preventDefault();
      const dx = event.clientX - dragStartRef.current.pointer.x;
      const dy = event.clientY - dragStartRef.current.pointer.y;
      setOffset(clampOffset({
        x: dragStartRef.current.offset.x + dx,
        y: dragStartRef.current.offset.y + dy,
      }));
    };
    const onPointerUp = () => {
      dragStartRef.current = null;
      setDragging(false);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [clampOffset]);

  if (Platform.OS !== "web") return null;

  async function saveCrop() {
    try {
      setError(null);
      if (!file) throw new Error("No logo file selected.");
      const img = imageRef.current;
      if (!img || !imageSize) throw new Error("Logo image is still loading.");
      const canvas = document.createElement("canvas");
      canvas.width = OUTPUT_SIZE;
      canvas.height = OUTPUT_SIZE;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Could not prepare the crop canvas.");

      ctx.clearRect(0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
      const scale = OUTPUT_SIZE / PREVIEW_SIZE;
      const drawX = ((PREVIEW_SIZE - displaySize.width) / 2 + offset.x) * scale;
      const drawY = ((PREVIEW_SIZE - displaySize.height) / 2 + offset.y) * scale;
      ctx.drawImage(img, drawX, drawY, displaySize.width * scale, displaySize.height * scale);

      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png", 0.92));
      if (!blob) throw new Error("Could not export the cropped logo.");
      const croppedFile = new File([blob], extensionSafeName(file.name), { type: "image/png" });
      await onSaveCropped(croppedFile);
    } catch (err: any) {
      setError(String(err?.message ?? "Could not crop this logo."));
    }
  }

  const imageLeft = (PREVIEW_SIZE - displaySize.width) / 2 + offset.x;
  const imageTop = (PREVIEW_SIZE - displaySize.height) / 2 + offset.y;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View
        style={{
          flex: 1,
          backgroundColor: "rgba(15, 23, 42, 0.34)",
          alignItems: "center",
          justifyContent: "center",
          padding: 18,
        }}
      >
        <View
          style={{
            width: "100%",
            maxWidth: 420,
            borderRadius: 14,
            borderWidth: 1,
            borderColor: "#dbe3ef",
            backgroundColor: "#ffffff",
            padding: 14,
          }}
        >
          <Text style={{ fontSize: 18, fontWeight: "900", color: "#0f172a" }}>Crop Team Logo</Text>
          <Text style={{ marginTop: 4, color: "#64748b", fontWeight: "700", fontSize: 12 }}>
            Drag to position the logo, then zoom until it fits the square preview.
          </Text>

          <View style={{ alignItems: "center", marginTop: 14 }}>
            <View
              {...(Platform.OS === "web"
                ? ({
                    onPointerDown: (event: PointerEvent) => {
                      if (saving || !imageSize) return;
                      event.preventDefault();
                      dragStartRef.current = {
                        pointer: { x: event.clientX, y: event.clientY },
                        offset,
                      };
                      setDragging(true);
                    },
                  } as any)
                : null)}
              style={{
                width: PREVIEW_SIZE,
                height: PREVIEW_SIZE,
                borderRadius: 18,
                borderWidth: 2,
                borderColor: "#0f172a",
                backgroundColor: "#f8fafc",
                overflow: "hidden",
                position: "relative",
                ...(Platform.OS === "web" ? ({ cursor: dragging ? "grabbing" : "grab", userSelect: "none" } as any) : null),
              }}
            >
              {objectUrl ? (
                <View
                  style={{
                    position: "absolute",
                    left: imageLeft,
                    top: imageTop,
                    width: displaySize.width,
                    height: displaySize.height,
                    backgroundImage: `url("${objectUrl}")`,
                    backgroundSize: "100% 100%",
                    backgroundRepeat: "no-repeat",
                  } as any}
                />
              ) : null}
              <View
                pointerEvents="none"
                style={{
                  position: "absolute",
                  inset: 0,
                  borderWidth: 1,
                  borderColor: "rgba(255,255,255,0.78)",
                } as any}
              />
            </View>
          </View>

          <View style={{ marginTop: 14 }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <Text style={{ fontSize: 12, fontWeight: "900", color: "#334155" }}>Zoom</Text>
              <Text style={{ fontSize: 12, fontWeight: "800", color: "#64748b" }}>{zoom.toFixed(2)}x</Text>
            </View>
            {React.createElement("input", {
              type: "range",
              min: MIN_ZOOM,
              max: MAX_ZOOM,
              step: 0.05,
              value: zoom,
              disabled: saving || !imageSize,
              onChange: (event: any) => {
                const nextZoom = clamp(Number(event?.target?.value ?? 1), MIN_ZOOM, MAX_ZOOM);
                setZoom(nextZoom);
                setOffset((current) => clampOffset(current, nextZoom));
              },
              style: { width: "100%" },
            })}
          </View>

          {error ? (
            <Text style={{ marginTop: 10, color: "#b00020", fontWeight: "800", fontSize: 12 }}>{error}</Text>
          ) : null}

          <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
            <Pressable
              disabled={saving}
              onPress={onCancel}
              style={{ borderWidth: 1, borderColor: "#d3dbe8", borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, opacity: saving ? 0.6 : 1 }}
            >
              <Text style={{ fontWeight: "900", color: "#334155" }}>Cancel</Text>
            </Pressable>
            <Pressable
              disabled={saving}
              onPress={() => {
                setZoom(1);
                setOffset({ x: 0, y: 0 });
              }}
              style={{ borderWidth: 1, borderColor: "#d3dbe8", borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, opacity: saving ? 0.6 : 1 }}
            >
              <Text style={{ fontWeight: "900", color: "#334155" }}>Reset</Text>
            </Pressable>
            {file ? (
              <Pressable
                disabled={saving}
                onPress={() => void onUseOriginal(file)}
                style={{ borderWidth: 1, borderColor: "#d3dbe8", borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, opacity: saving ? 0.6 : 1 }}
              >
                <Text style={{ fontWeight: "900", color: "#334155" }}>Use Original</Text>
              </Pressable>
            ) : null}
            <Pressable
              disabled={saving || !imageSize}
              onPress={() => void saveCrop()}
              style={{
                borderWidth: 1,
                borderColor: "#10131a",
                borderRadius: 10,
                backgroundColor: "#10131a",
                paddingHorizontal: 12,
                paddingVertical: 8,
                opacity: saving || !imageSize ? 0.6 : 1,
              }}
            >
              <Text style={{ fontWeight: "900", color: "#fff" }}>{saving ? "Saving..." : "Save Cropped Logo"}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}
