import React, { useEffect, useRef } from "react";
import { useAudio } from "../context/AudioContext";

const BAR_COUNT = 32;

export const AudioVisualizer: React.FC<{ className?: string }> = ({ className }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef<number>();
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const widthRef = useRef(0);
  const heightRef = useRef(0);
  const { status, getFrequencyData, visualizerAvailable } = useAudio();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctxRef.current = ctx;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      widthRef.current = rect.width;
      heightRef.current = rect.height;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, rect.width, rect.height);
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!visualizerAvailable) {
      if (frameRef.current) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = undefined;
      }
      const ctx = ctxRef.current;
      const width = widthRef.current;
      const height = heightRef.current;
      if (ctx && width > 0 && height > 0) {
        ctx.clearRect(0, 0, width, height);
      }
      return;
    }

    const render = () => {
      const ctx = ctxRef.current;
      const width = widthRef.current;
      const height = heightRef.current;
      if (!ctx || width <= 0 || height <= 0) {
        frameRef.current = requestAnimationFrame(render);
        return;
      }

      const frequencyData = getFrequencyData?.();
      ctx.clearRect(0, 0, width, height);

      if (frequencyData && frequencyData.length) {
        const data = frequencyData;
        const barCount = Math.min(BAR_COUNT, data.length);
        const step = Math.max(1, Math.floor(data.length / barCount));
        const barWidth = width / barCount;

        for (let i = 0; i < barCount; i++) {
          let total = 0;
          const start = i * step;
          for (let j = 0; j < step && start + j < data.length; j++) {
            total += data[start + j] ?? 0;
          }
          const magnitude = total / step / 255;
          const barHeight = magnitude * height;
          const x = i * barWidth;
          const y = height - barHeight;
          ctx.fillStyle = "rgba(16, 185, 129, 0.75)"; // emerald tone
          ctx.fillRect(x + barWidth * 0.2, y, barWidth * 0.6, barHeight);
        }
      }

      frameRef.current = requestAnimationFrame(render);
    };

    if (status === "playing" && visualizerAvailable) {
      frameRef.current = requestAnimationFrame(render);
    } else {
      const ctx = ctxRef.current;
      const width = widthRef.current;
      const height = heightRef.current;
      if (ctx && width > 0 && height > 0) {
        ctx.clearRect(0, 0, width, height);
      }
    }

    return () => {
      if (frameRef.current) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = undefined;
      }
    };
  }, [status, getFrequencyData, visualizerAvailable]);

  return <canvas ref={canvasRef} className={className} style={{ width: "100%", height: "100%" }} />;
};
