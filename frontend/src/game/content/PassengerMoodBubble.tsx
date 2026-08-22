"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useGameStore } from "../store";
import { ECONOMY } from "../economy";

// Dolmuşun üstünde yüzen yolcu ruh hâli balonu.
// Memnuniyet sayacı bir SAYI'dır; oyuncu neden düştüğünü göremiyordu. Bu balon
// yolcuların o anki hâlini yüz ifadesiyle anlatır ve memnuniyet DÜŞERKEN
// (örn. hızlı sürüş) tepki verir.
//
// Emoji'ler canvas'a çizilip sprite dokusuna dönüştürülür: DOM overlay yok,
// yazı tipi dosyası yok, tek draw call.

const MOODS = ["angry", "unhappy", "neutral", "happy"] as const;
type Mood = (typeof MOODS)[number];

const MOOD_EMOJI: Record<Mood, string> = {
  angry: "😠",
  unhappy: "😕",
  neutral: "🙂",
  happy: "😄",
};

const TEXTURE_SIZE = 128;

function createMoodTexture(emoji: string): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = TEXTURE_SIZE;
  canvas.height = TEXTURE_SIZE;
  const ctx = canvas.getContext("2d")!;

  // Beyaz konuşma balonu zemini — emoji şehir üstünde okunaklı kalsın.
  ctx.beginPath();
  ctx.arc(TEXTURE_SIZE / 2, TEXTURE_SIZE / 2, TEXTURE_SIZE / 2 - 6, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.94)";
  ctx.fill();
  ctx.lineWidth = 5;
  ctx.strokeStyle = "rgba(20,25,32,0.55)";
  ctx.stroke();

  ctx.font = `${TEXTURE_SIZE * 0.56}px serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(emoji, TEXTURE_SIZE / 2, TEXTURE_SIZE / 2 + 4);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function moodForSatisfaction(satisfaction: number): Mood {
  const { moodAngryBelow, moodUnhappyBelow, moodHappyAbove } = ECONOMY.satisfaction;
  if (satisfaction < moodAngryBelow) return "angry";
  if (satisfaction < moodUnhappyBelow) return "unhappy";
  if (satisfaction >= moodHappyAbove) return "happy";
  return "neutral";
}

export function PassengerMoodBubble() {
  const satisfaction = useGameStore((s) => s.satisfaction);
  const passengers = useGameStore((s) => s.passengersOnBoard);
  const moodReason = useGameStore((s) => s.moodReason);

  const sprite = useRef<THREE.Sprite>(null!);
  const life = useRef(0);
  /** Sebep geldiğinde (örn. hız) balon zıplar — dikkat çeker. */
  const pulse = useRef(0);

  const textures = useMemo(() => {
    const map = {} as Record<Mood, THREE.CanvasTexture>;
    for (const mood of MOODS) map[mood] = createMoodTexture(MOOD_EMOJI[mood]);
    return map;
  }, []);

  useEffect(() => () => Object.values(textures).forEach((t) => t.dispose()), [textures]);

  // Sebep her değiştiğinde tepki animasyonunu tetikle.
  useEffect(() => {
    if (moodReason) pulse.current = 1;
  }, [moodReason]);

  // Hiz da sert fren de ayni tepkiyi verir: arkadaki yolcu rahatsiz.
  const mood = moodReason ? "angry" : moodForSatisfaction(satisfaction);

  useFrame((_, delta) => {
    if (!sprite.current) return;
    const step = Math.min(delta, 0.05);
    life.current += step;
    pulse.current = Math.max(0, pulse.current - step * 1.6);

    // Yumuşak süzülme + tepki zıplaması.
    sprite.current.position.y = 1.85 + Math.sin(life.current * 2.2) * 0.06 + pulse.current * 0.22;
    const scale = 0.5 + pulse.current * 0.22;
    sprite.current.scale.set(scale, scale, scale);
  });

  // Araçta yolcu yoksa gösterecek ruh hâli de yok.
  if (passengers <= 0) return null;

  return (
    <sprite ref={sprite} position={[0, 1.85, 0]} scale={[0.5, 0.5, 0.5]}>
      <spriteMaterial map={textures[mood]} transparent depthTest={false} />
    </sprite>
  );
}
