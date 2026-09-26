import { useRef, useState } from 'react';

export function Joystick({ joystick, hidden = false }) {
  const baseRef = useRef(null);
  const dragging = useRef(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  const update = (clientX, clientY) => {
    if (!dragging.current || !baseRef.current) return;
    const rect = baseRef.current.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const dx = clientX - centerX;
    const dy = clientY - centerY;
    const maxRadius = rect.width / 2 - 24;
    const dist = Math.hypot(dx, dy);
    const clamped = Math.min(dist, maxRadius) / maxRadius;
    const angle = Math.atan2(dy, dx);
    const nx = Math.cos(angle) * clamped;
    const ny = Math.sin(angle) * clamped;
    const px = nx * maxRadius;
    const py = ny * maxRadius;
    setPos({ x: px, y: py });
    if (joystick) joystick.current = { x: nx, y: ny };
  };

  const end = () => {
    dragging.current = false;
    setPos({ x: 0, y: 0 });
    if (joystick) joystick.current = { x: 0, y: 0 };
  };

  const onPointerDown = (e) => {
    dragging.current = true;
    update(e.clientX, e.clientY);
  };

  const onPointerMove = (e) => {
    update(e.clientX, e.clientY);
  };

  const onPointerUp = () => {
    end();
  };

  return (
    <div
      ref={baseRef}
      className={'fixed bottom-8 left-8 z-50 h-32 w-32 touch-none select-none rounded-full border border-slate-600/50 bg-slate-900/40 backdrop-blur-sm ' + (hidden ? 'hidden' : 'block')}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
    >
      <div
        className='absolute left-1/2 top-1/2 h-12 w-12 rounded-full bg-cyan-500/80 shadow-lg'
        style={{ transform: `translate(calc(-50% + ${pos.x}px), calc(-50% + ${pos.y}px))` }}
      />
    </div>
  );
}
