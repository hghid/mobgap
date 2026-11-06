const namespace = 'http://www.w3.org/2000/svg';
const colors = ['#2563eb', '#d97706', '#059669'];
const labels = { accelerometer: 'Accelerometer', gyroscope: 'Gyroscope' };

function element(name, attributes = {}, text) {
  const item = document.createElementNS(namespace, name);
  for (const [key, value] of Object.entries(attributes)) item.setAttribute(key, String(value));
  if (text !== undefined) item.textContent = text;
  return item;
}

export function clockLabel(seconds) {
  const value = Math.max(0, Math.floor(seconds));
  return [Math.floor(value / 3600), Math.floor(value / 60) % 60, value % 60]
    .map((part) => String(part).padStart(2, '0')).join(':');
}

/** Draw a responsive SVG containing only the bounded preview for the selected day and sensor group. */
export function renderTimeseries(svg, caption, empty, preview, group) {
  svg.replaceChildren();
  empty.hidden = Boolean(preview);
  svg.hidden = !preview;
  caption.textContent = '';
  if (!preview) return;
  const series = preview.groups[group];
  const title = `${labels[group]} (${series.unit}) — ${preview.date}`;
  svg.setAttribute('aria-label', title);
  svg.append(element('title', {}, title));
  const pointCount = Math.max(...series.traces.map((trace) => trace.points.length));
  caption.textContent = `${preview.date} · ${clockLabel(preview.start_s)}–${clockLabel(preview.end_s)} device clock · ${preview.sample_count.toLocaleString()} decoded samples at ${preview.sample_rate_hz} Hz · up to ${pointCount.toLocaleString()} plotted points per axis (peaks retained).`;
  svg.append(element('desc', {}, caption.textContent));
  const area = { left: 78, right: 978, top: 42, bottom: 300 };
  let minimum = Infinity;
  let maximum = -Infinity;
  for (const trace of series.traces) for (const [, value] of trace.points) {
    minimum = Math.min(minimum, value); maximum = Math.max(maximum, value);
  }
  const padding = maximum === minimum ? Math.max(Math.abs(maximum) * 0.1, 0.1) : (maximum - minimum) * 0.08;
  minimum -= padding; maximum += padding;
  const span = Math.max(preview.end_s - preview.start_s, 0.001);
  const x = (time) => area.left + (time - preview.start_s) / span * (area.right - area.left);
  const y = (value) => area.bottom - (value - minimum) / (maximum - minimum) * (area.bottom - area.top);
  const formatter = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 3 });
  for (let index = 0; index <= 5; index++) {
    const fraction = index / 5;
    const row = area.top + fraction * (area.bottom - area.top);
    svg.append(element('line', { x1: area.left, x2: area.right, y1: row, y2: row, stroke: '#e5eaf1' }));
    svg.append(element('text', { x: area.left - 12, y: row + 4, 'text-anchor': 'end' }, formatter.format(maximum - fraction * (maximum - minimum))));
    const time = preview.start_s + fraction * span;
    svg.append(element('text', { x: x(time), y: area.bottom + 24, 'text-anchor': index === 0 ? 'start' : index === 5 ? 'end' : 'middle' }, clockLabel(time)));
  }
  svg.append(element('text', { x: area.left, y: 20, class: 'plot-axis-label' }, `${labels[group]} (${series.unit})`));
  svg.append(element('text', { x: (area.left + area.right) / 2, y: 347, 'text-anchor': 'middle', class: 'plot-axis-label' }, 'Time of day (device clock)'));
  series.traces.forEach((trace, index) => {
    svg.append(element('polyline', {
      points: trace.points.map(([time, value]) => `${x(time).toFixed(2)},${y(value).toFixed(2)}`).join(' '),
      fill: 'none', stroke: colors[index], 'stroke-width': 1.4, 'vector-effect': 'non-scaling-stroke',
      'aria-label': `${trace.axis.toUpperCase()} axis`,
    }));
    const legendX = area.right - 145 + index * 55;
    svg.append(element('line', { x1: legendX, x2: legendX + 16, y1: 16, y2: 16, stroke: colors[index], 'stroke-width': 3 }));
    svg.append(element('text', { x: legendX + 22, y: 20 }, trace.axis.toUpperCase()));
  });
}
