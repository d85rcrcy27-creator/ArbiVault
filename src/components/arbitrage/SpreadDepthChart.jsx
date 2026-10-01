export default function SpreadDepthChart({ history, spread }) {
  const data = history && history.length ? history : [0];
  const max = Math.max(...data, 0.01);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const points = data.map((v, i) => {
    const x = data.length === 1 ? 0 : (i / (data.length - 1)) * 100;
    const y = 100 - ((v - min) / range) * 100;
    return `${x},${y}`;
  }).join(' ');

  const line = data.length === 1 ? `0,${100 - ((data[0] - min) / range) * 100} 100,${100 - ((data[0] - min) / range) * 100}` : points;
  const isPositive = spread > 0.2;
  const strokeColor = isPositive ? '#00FF87' : '#FFB800';
  const fillColor = isPositive ? 'rgba(0,255,135,0.12)' : 'rgba(255,184,0,0.12)';

  return (
    <div className="relative h-full w-full">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full">
        <polyline points={`0,100 ${line} 100,100`} fill={fillColor} stroke="none" />
        <polyline
          points={line}
          fill="none"
          stroke={strokeColor}
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
  );
}
