const errorNotice = document.getElementById('error-notice');

function stat(label, value, accent) {
  const card = document.createElement('div');
  card.className = accent ? 'stat accent' : 'stat';
  const l = document.createElement('div');
  l.className = 'label';
  l.textContent = label;
  const v = document.createElement('div');
  v.className = 'value';
  v.textContent = value.toLocaleString();
  card.append(l, v);
  return card;
}

function renderChart(series) {
  const bars = document.getElementById('bars');
  const axis = document.getElementById('bar-axis');
  bars.replaceChildren();
  axis.replaceChildren();

  const peak = Math.max(1, ...series.map((d) => d.uploads));

  for (const day of series) {
    const col = document.createElement('div');
    col.className = 'bar-col';
    const bar = document.createElement('div');
    bar.className = day.uploads === 0 ? 'bar zero' : 'bar';
    bar.style.setProperty('--h', ((day.uploads / peak) * 100).toFixed(2));
    bar.title = `${day.day}: ${day.uploads} checked`;
    col.append(bar);
    bars.append(col);
  }

  bars.setAttribute('aria-label',
    `Daily files checked over the last ${series.length} days. Peak of ${peak} on a single day.`);

  const first = document.createElement('span');
  first.textContent = series[0]?.day ?? '';
  const last = document.createElement('span');
  last.textContent = `${series.at(-1)?.day ?? ''} (peak ${peak})`;
  axis.append(first, last);
}

async function load() {
  try {
    const response = await fetch('/api/stats?days=30');
    if (!response.ok) throw new Error('stats unavailable');
    const stats = await response.json();

    document.getElementById('uploads-stats').replaceChildren(
      stat('Today', stats.today.uploads, true),
      stat('Yesterday', stats.yesterday.uploads),
      stat('Last 30 days', stats.window.uploads),
    );
    document.getElementById('recs-stats').replaceChildren(
      stat('Today', stats.today.recommendations, true),
      stat('Yesterday', stats.yesterday.recommendations),
      stat('Last 30 days', stats.window.recommendations),
    );
    renderChart(stats.series);

    // Be straight about it when the store is ephemeral rather than quietly
    // showing numbers that reset every time the instance sleeps.
    if (!stats.persistent) {
      document.getElementById('chart-note').textContent =
        'One bar per day, UTC. These counters are held on the instance itself, so they reset whenever it restarts.';
    }
  } catch {
    errorNotice.textContent = 'The activity counters could not be loaded right now.';
    errorNotice.hidden = false;
  }
}

load();
