/**
 * The Operations tab: what the machine is doing, who is enrolled, and what an operator recorded
 * by hand
 *
 * Served to the operator tier only, and drawn from the `ops` half of the snapshot, which only
 * an operator is sent. Every element it reaches for has an id under o- (m- and g- for the
 * manual entry), and a delegated click finds its control by a data-* attribute: no class is a
 * hook, so a class can be renamed for its looks alone.
 */
(() => {
  'use strict';

  const { $, esc, fmt, cls, VOCAB, dom, marks, stats, ui, token, reduceMotion } = Dash;

  // The operational half of the last snapshot. Replaced whole by snapshot() below.
  let ops = null;

  const KINDS = ['sync', 'poll'];

  /** "1 h tier", or "6 h backoff" for the band above the ceiling. */
  const tierWord = (subject) => `${fmt.tier(subject.tier)} ${subject.tier === ops.ladders[subject.kind].backoff ? 'backoff' : 'tier'}`;

  const failuresInARow = (subject) => `${fmt.plural(subject.errors, 'failure', 'failures')} in a row`;

  /**
   * When a subject is due, in the words the tiles count it by
   *
   * Overdue only once a tick has gone by since it fell due and nothing holds it, as
   * getSubjectStates() decides: before that it is waiting for the next run by construction.
   */
  const dueText = (subject) => {
    const past = Dash.now() - Date.parse(subject.dueAt);

    if (!subject.claimed && past > ops.limits.tickMinutes[subject.kind] * 60000) return fmt.until(subject.dueAt);

    return past > 0 ? `due ${fmt.ago(subject.dueAt)}` : fmt.until(subject.dueAt);
  };

  /* ---- the tiles ------------------------------------------------------------ */

  /** How long the oldest claim of either queue has been held: the Claimed tile's and the bar's. */
  const oldestClaim = () => {
    const claims = KINDS.map((kind) => ops.subjects[kind].oldestClaimAt).filter(Boolean).map(Date.parse);

    return claims.length > 0 ? fmt.span(Dash.now() - Math.min(...claims)) : null;
  };

  const sum = (key) => ops.subjects.sync[key] + ops.subjects.poll[key];

  const drawTiles = () => {
    const late = ops.subjects.oldestLate;
    const failing = ops.jobs.filter((job) => job.state === 'failing');
    const claim = oldestClaim();

    ui.tiles($('o-tiles'), [
      {
        key: 'overdue', label: 'Overdue subjects', value: fmt.n(sum('overdue')), base: `of ${fmt.n(sum('tracked'))} tracked`,
        sub: [`${fmt.n(sum('overdueOnFloor'))} on the floor tier`], tint: 'now', late: true,
      },
      {
        // Nothing overdue is a fact, not a figure below its threshold: "none", dimmed, not "—".
        key: 'lateness', label: 'Oldest lateness', value: late ? fmt.span(Dash.now() - Date.parse(late.dueAt)) : 'none',
        sub: late ? [late.label, tierWord(late)] : [], tint: 'now', late: true, zero: !late,
      },
      {
        key: 'claimed', label: 'Claimed now', value: fmt.n(sum('claimed')),
        base: sum('claimed') === 1 ? 'subject under lease' : 'subjects under lease',
        sub: [claim && `oldest claim ${claim}`], tint: 'sync',
      },
      {
        key: 'failing', label: 'Failing jobs', value: fmt.n(failing.length), base: `of ${fmt.n(ops.jobs.length)}`,
        sub: [failing.map((job) => job.name).join(', ')], tint: 'fail',
      },
    ]);
  };

  /* ---- the jobs ------------------------------------------------------------- */

  /**
   * How much of a job's cycle has elapsed, as a CSS width
   *
   * A job that has never run, or whose schedule is unreadable, gets no bar at all rather than
   * a full one - "about to fire" is the one thing it must not imply.
   * @returns {string} e.g. "40.01%"
   */
  const tickWidth = (from, to) => {
    const span = Date.parse(to) - Date.parse(from);
    const done = span > 0 ? Math.max(0, Math.min(1, (Dash.now() - Date.parse(from)) / span)) : 0;

    return `${(done * 100).toFixed(2)}%`;
  };

  /** A run's duration as production wrote it: to a tenth of a second between one and sixty. */
  const took = (ms) => (ms >= 1000 && ms < 60000 ? `${(ms / 1000).toFixed(1)}\u00a0s` : fmt.span(ms));

  /**
   * The last runs of a job, one bar each, the oldest first
   *
   * Height is how long a run took, colour how it ended. Square-rooted, so a 20-second run beside
   * 40-millisecond ones does not flatten them into the baseline - which leaves an idle run the
   * short dark bar it is, and a slot no run filled a hairline: the gap a status light cannot show.
   * Each bar says what it was on hover, so the colours need no key.
   */
  const sparkline = (runs) => {
    const peak = Math.max(1, ...runs.map((run) => run.durationMs || 0));
    const tally = ops.limits.outcomes
      .map((outcome) => [outcome, runs.filter((run) => run.outcome === outcome).length])
      .filter(([, count]) => count > 0)
      .map(([outcome, count]) => `${fmt.n(count)} ${outcome}`);
    const bars = [
      ...Array(Math.max(0, ops.limits.sparklineRuns - runs.length)).fill('<i class="gap"></i>'),
      ...runs.map((run) => `<i class="${cls(VOCAB.RUN_OUTCOMES, run.outcome)}" style="height:${
        (4 + 38 * Math.sqrt((run.durationMs || 0) / peak)).toFixed(1)}px" title="${esc(run.outcome)} in ${esc(took(run.durationMs || 0))}"></i>`),
    ];
    const label = runs.length > 0 ? `Last ${fmt.plural(runs.length, 'run', 'runs')}: ${tally.join(', ')}` : 'No run recorded yet';

    return `<div class="spark" role="img" aria-label="${esc(label)}">${bars.join('')}</div>`;
  };

  /**
   * What the last 24 hours add up to, each figure in bold
   *
   * Two kinds of failure, because they are two events: a failed RUN is the job breaking, a failed
   * SUBJECT in a run that completed is the parc - and 5 of 444 is not 444 of 444, the one where
   * the run reports ok and nothing was collected. That one is in the failure colour, the others
   * in the warning's.
   */
  const windowStats = ({ window: day }) => {
    const nothingGotThrough = day.subjectsClaimed > 0 && day.subjectsFailed >= day.subjectsClaimed;
    const subjects = day.subjectsFailed === 0 ? '' : nothingGotThrough ? ' class="failing"' : ' class="degraded"';

    return '<p class="job-stats">'
      + `<span><b>${fmt.n(day.runs)}</b> runs in 24\u00a0h</span> `
      + `<span${day.failed > 0 ? ' class="failing"' : ''}><b>${fmt.n(day.failed)}</b> runs failed</span> `
      + `<span${subjects}><b>${fmt.n(day.subjectsFailed)}</b>/${fmt.n(day.subjectsClaimed)} subjects failed</span> `
      + `<span><b>${fmt.n(day.idle)}</b> idle</span> `
      + `<span>avg <b>${esc(took(day.avgDurationMs))}</b></span> `
      + `<span>peak <b>${esc(took(day.maxDurationMs))}</b></span></p>`;
  };

  /**
   * Which run each job had when the cards were last drawn
   *
   * So a card flashes on ITS OWN tick rather than on any job's. Empty on the first render on
   * purpose: everything is new then, and three cards flashing on load is noise.
   */
  const lastRunByJob = new Map();

  /**
   * One card per job, as production drew them
   *
   * Nothing in the markup moves with the clock - the countdown, the last run's age and the
   * tick bar are written by clocks() straight after it, and every second - so a refresh that
   * brought nothing new rewrites nothing. The bar is still born at its width: set before the
   * first paint, it has no earlier width to be transitioned from.
   */
  const drawJobs = () => {
    const html = ops.jobs.map((job, k) => {
      const last = job.runs.at(-1)?.startedAt ?? null;
      const justRan = lastRunByJob.has(job.name) && lastRunByJob.get(job.name) !== last;

      lastRunByJob.set(job.name, last);

      return `<article class="job${justRan ? ' just-ran' : ''}" data-state="${cls(VOCAB.JOB_STATES, job.state)}">`
        + `<i class="job-tick" id="o-job-${k}-tick" data-running="${job.running ? '1' : '0'}"></i>`
        + `<div class="job-head"><span class="job-name">${esc(job.name)}</span>`
        + `<span class="pill ${cls(VOCAB.JOB_STATES, job.state)}">${esc(job.state)}</span></div>`
        + `<p class="job-line">${ui.fragments([`cron <code>${esc(job.cron)}</code>`, `last ran <span id="o-job-${k}-ago"></span>`])}</p>`
        // Not an <output>: that is a live region, and this one is rewritten every second.
        + `<p class="job-line job-next"><span>next run</span><span class="at" id="o-job-${k}-next"></span></p>`
        + `${sparkline(job.runs)}${windowStats(job)}`
        + `${job.state === 'failing' ? `<p class="cause">${esc(job.lastError ?? 'no cause recorded')}</p>` : ''}</article>`;
    }).join('');

    dom.swap($('o-jobs'), html || ui.nothing('No job is scheduled in this process.'));
  };

  /** Each card's clock: when it last ran, when it runs next, how far through the cycle it is. */
  const clocks = () => ops.jobs.forEach((job, k) => {
    const last = job.runs.at(-1)?.startedAt ?? null;
    const next = Date.parse(job.nextRunAt) - Dash.now();

    dom.text($(`o-job-${k}-ago`), last ? fmt.ago(last) : 'never');
    dom.text($(`o-job-${k}-next`), job.nextRunAt === null ? 'schedule unreadable' : next <= 0 ? 'due now' : `in ${fmt.span(next)}`);
    // A running bar shows the sweep across a full-width track; a percentage written over it
    // would cut the track short and leave the segment sweeping a stub.
    $(`o-job-${k}-tick`).style.width = job.running ? '100%' : tickWidth(last, job.nextRunAt);
  });

  /* ---- the queue ------------------------------------------------------------ */

  const canvas = $('o-track');
  const ctx = canvas.getContext('2d');
  const tip = $('o-track-tip');

  // The tokens the track is painted in: the legend under it is drawn in the same.
  const PAINT = {
    sync: token('sync'), poll: token('poll'), fail: token('fail'), now: token('now'),
    line: token('line'), lineSoft: token('line-soft'), dim: token('ink-dim'), mute: token('ink-mute'),
  };
  // Every token is a #rrggbb, which a canvas takes with an alpha only as rgba().
  const alpha = (hex, a) => `rgba(${parseInt(hex.slice(1, 3), 16)},${
    parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`;
  // The page's face, at 500 at most: Plex Sans is loaded at 400 and 500 only.
  const TYPE = (weight) => `${weight} ${token('fs-12')} ${token('sans')}`;

  // The NOW marker and the past's labels are drawn in it, at a strength that still reads as text
  // on the track: lighter, the past's figures fell under 4.5:1.
  const NOW_INK = 0.8;

  const LANES = [
    { key: 'sync', label: 'Installations', colour: PAINT.sync },
    { key: 'poll', label: 'Pull requests', colour: PAINT.poll },
  ];

  // The axis, in minutes relative to NOW. It starts in the PAST on purpose: overdue subjects
  // need a region of their own, otherwise they pile up on the left edge on top of the lane
  // labels and the one thing worth seeing is the one thing you cannot read.
  const PAST_MINUTES = 30;

  const PAD_L = 14;
  const PAD_R = 66;

  // Where each token sits, and what its tooltip says about it: rebuilt on every draw, read on
  // every hover.
  let plotted = [];
  let flashUntil = 0;
  let lastRunStamp = '';

  /**
   * Minutes from now until a due time
   *
   * A null due time IS due, exactly as the claim queries read it.
   */
  const minutesUntil = (at) => (at === null ? 0 : (Date.parse(at) - Dash.now()) / 60000);

  /**
   * A stable vertical offset for a token
   *
   * Derived from its position in the queue rather than drawn at random, so a token does not
   * jump to a new row every time the page refreshes.
   */
  const jitterOf = (index) => {
    const x = Math.sin(index * 12.9898) * 43758.5453;

    return (x - Math.floor(x)) - 0.5;
  };

  const draw = () => {
    const box = canvas.getBoundingClientRect();
    const W = box.width;
    const H = box.height;
    const ratio = Math.min(2, devicePixelRatio || 1);

    // Sized on the draw rather than on the window's resize: the tab may have been hidden, and the
    // canvas 0 wide, the last time the window changed.
    if (canvas.width !== Math.round(W * ratio) || canvas.height !== Math.round(H * ratio)) {
      canvas.width = Math.round(W * ratio);
      canvas.height = Math.round(H * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    }

    // The future is laid out on the ladder the adaptive interval climbs, each step given equal
    // width. A linear axis to the ceiling would spend most of its width on an empty tail.
    const { edges, shape, subjects } = ops.queue;
    const horizon = edges.at(-1);

    // Vertical metrics, named and derived from the canvas box, because the marker used to be
    // drawn at y=4 with the default alphabetic baseline — so its ascender reached y≈-3 and
    // the NOW label was sliced off above the top edge, together with the glow around the
    // line. Every baseline below is therefore set explicitly.
    const MARKER_Y = 15;               // centre of the NOW / CLAIMED marker
    const TOP = 34;                    // first pixel a lane may use
    const BOTTOM = 20;                 // reserved for the axis labels
    const gridTop = MARKER_Y + 10;
    const gridBottom = H - BOTTOM - 2;

    // The right gutter holds the "+N beyond" figure, but it cannot be a fixed 66px on a
    // narrow canvas: the span was floored at 120px, which drew the whole axis past the right
    // edge below ~200px wide.
    const padR = Math.min(PAD_R, Math.max(10, W * 0.1));
    const span = Math.max(40, W - PAD_L - padR);

    // The past keeps one step's worth of width; each future step gets one more. Piecewise, so
    // the quarter hour that matters is not compressed by the hours that rarely fill.
    const bandW = span / (edges.length + 1);

    const xOf = (minutes) => {
      const m = Math.min(horizon, Math.max(-PAST_MINUTES, minutes));

      if (m <= 0) return PAD_L + ((m + PAST_MINUTES) / PAST_MINUTES) * bandW;

      let from = 0;

      for (let i = 0; i < edges.length; i++) {
        const to = edges[i];

        if (m <= to) return PAD_L + (i + 1 + (m - from) / (to - from)) * bandW;
        from = to;
      }

      return PAD_L + span;
    };

    const nowX = xOf(0);
    const laneH = (H - TOP - BOTTOM) / LANES.length;
    // The top of each lane is a text row; tokens live on the rail below it. They can never
    // overlap, whatever the queue does.
    const headerH = 22;

    ctx.clearRect(0, 0, W, H);

    // The overdue region, named by shading rather than by a label competing for space.
    ctx.fillStyle = alpha(PAINT.now, 0.035);
    ctx.fillRect(PAD_L, gridTop, nowX - PAD_L, gridBottom - gridTop);

    ctx.font = TYPE('400');
    ctx.textBaseline = 'alphabetic';

    // One line per ladder step, plus the middle of the past band. No minor gridlines: the
    // spacing is not uniform, so a five-minute rule would read as a scale it is not. Each figure
    // and its unit as the page writes them, a space apart.
    const label = (minutes) => `${minutes > 0 ? '+' : ''}${minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`}`;

    // Where the last label drawn ends: on a phone the steps are narrower than their labels, and
    // a label that would run into the one before it is left out rather than drawn over it.
    let drawnTo = -Infinity;

    for (const minutes of [-PAST_MINUTES, -PAST_MINUTES / 2, ...edges]) {
      const x = xOf(minutes);

      // The first label starts on its line rather than centring on it: centred, half of it was
      // drawn off the canvas's left edge.
      ctx.textAlign = minutes === -PAST_MINUTES ? 'left' : 'center';

      ctx.strokeStyle = alpha(PAINT.line, 0.95);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, gridTop);
      ctx.lineTo(x, gridBottom);
      ctx.stroke();

      const text = label(minutes);
      const width = ctx.measureText(text).width;
      const left = ctx.textAlign === 'left' ? x : x - width / 2;

      if (left >= drawnTo + 8) {
        ctx.fillStyle = minutes < 0 ? alpha(PAINT.now, NOW_INK) : PAINT.mute;
        ctx.fillText(text, x, H - 7);
        drawnTo = left + width;
      }
    }

    plotted = [];

    LANES.forEach((lane, index) => {
      const top = TOP + index * laneH;
      const railY = top + headerH + (laneH - headerH) / 2;
      const band = (laneH - headerH) * 0.62;

      const counts = shape[lane.key];
      const total = counts.reduce((all, count) => all + count, 0);
      const heads = subjects[lane.key];

      ctx.textAlign = 'left';
      ctx.font = TYPE('500');
      ctx.fillStyle = PAINT.dim;

      const heading = lane.label;
      // Measured while the heading's own font is still active: measuring it under the
      // lighter font set below reports a narrower string than was drawn, and the counts
      // then start inside the last letter of the label.
      const headingWidth = ctx.measureText(heading).width;

      ctx.fillText(heading, PAD_L, top + 10);

      ctx.font = TYPE('400');
      ctx.fillStyle = PAINT.mute;

      const tally = `${fmt.n(total)} queued, ${fmt.n(counts[0])} due${heads.length < total ? `, showing the next ${fmt.n(heads.length)}` : ''}`;
      const after = PAD_L + headingWidth + 12;
      // Past the NOW line when it would run across it: the line is drawn over everything, and
      // struck through, the figures under it were unreadable.
      const crosses = after < nowX + 8 && after + ctx.measureText(tally).width > nowX - 6;

      ctx.fillText(tally, crosses ? nowX + 8 : after, top + 10);

      ctx.strokeStyle = alpha(PAINT.lineSoft, 0.9);
      ctx.beginPath();
      ctx.moveTo(PAD_L, railY);
      ctx.lineTo(W - PAD_R + 24, railY);
      ctx.stroke();

      heads.forEach((subject, position) => {
        const m = minutesUntil(subject.at);
        const x = xOf(m);
        const y = railY + jitterOf(position) * band;
        const radius = subject.claimed ? 3.4 : 2.6;

        // Overdue is what the eye should land on, so the future fades with distance.
        ctx.globalAlpha = m <= 0 ? 1 : Math.max(0.3, 1 - m / (horizon * 1.3));

        // A subject in error backoff is drawn in the failure colour: it is in the queue,
        // but it is there because something went wrong, not because its turn came round.
        ctx.fillStyle = subject.errors > 0 ? PAINT.fail : lane.colour;

        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();

        // A ring marks a row a worker is holding: still in the queue, skipped by the next
        // run until its lease expires.
        if (subject.claimed) {
          ctx.globalAlpha = 1;
          ctx.strokeStyle = PAINT.now;
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.arc(x, y, radius + 2.6, 0, Math.PI * 2);
          ctx.stroke();
        }

        plotted.push({ x, y, m, key: lane.key, subject });
      });

      ctx.globalAlpha = 1;

      if (heads.length < total) {
        ctx.textAlign = 'right';
        ctx.font = TYPE('400');
        ctx.fillStyle = PAINT.mute;
        ctx.fillText(`+${fmt.n(total - heads.length)} beyond`, W - 4, railY + 3);
      }
    });

    const flashing = flashUntil > performance.now();
    const flash = flashing ? (flashUntil - performance.now()) / 900 : 0;

    ctx.save();
    ctx.strokeStyle = PAINT.now;
    ctx.lineWidth = flashing ? 2 + flash * 2.5 : 1.6;
    ctx.shadowColor = alpha(PAINT.now, 0.35 + flash * 0.5);
    ctx.shadowBlur = flashing ? 18 + flash * 26 : 10;
    ctx.beginPath();
    ctx.moveTo(nowX, gridTop);
    ctx.lineTo(nowX, gridBottom);
    ctx.stroke();
    ctx.restore();

    // Centred on MARKER_Y rather than hung off an alphabetic baseline, so the marker sits
    // wholly inside the canvas whatever the font metrics turn out to be.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = TYPE('500');
    ctx.fillStyle = flashing ? PAINT.now : alpha(PAINT.now, NOW_INK);
    ctx.fillText(flashing ? 'CLAIMED' : 'NOW', nowX, MARKER_Y);
    ctx.textBaseline = 'alphabetic';
  };

  /**
   * What one queued subject says about itself, as its tooltip's markup
   *
   * When it is due, how often it is looked at, whether a worker holds it, whether it is backing
   * off and why it last failed. Escaped here, once: the parts carry a subject's own words - a
   * branch name, GitHub's error message - and an unescaped one is stored XSS.
   * @param {number} m - Minutes until it is due, negative once it is overdue
   * @returns {string}
   */
  const tipOf = (subject, key, m) => {
    const poll = key === 'poll';
    const plain = (text) => `<span>${esc(text)}</span>`;

    return [
      `<b>${esc(subject.label)}</b>`,
      subject.sub && `<i>${esc(poll ? `opened by ${subject.sub}` : `last synced ${fmt.ago(subject.sub)}`)}</i>`,
      plain(m <= 0 ? (m < -0.5 ? `overdue by ${fmt.span(-m * 60000)}` : 'due now') : `due in ${fmt.span(m * 60000)}`),
      poll && Number.isFinite(subject.commits) && plain(fmt.plural(subject.commits, 'commit', 'commits')),
      poll && subject.openedAt && plain(`opened ${fmt.ago(subject.openedAt)}`),
      poll && subject.lastPolledAt && plain(`last polled ${fmt.ago(subject.lastPolledAt)}`),
      subject.intervalMinutes && plain(`every ${fmt.tier(subject.intervalMinutes)}`),
      subject.claimed && '<span class="now">held by a worker right now</span>',
      subject.errors > 0 && `<span class="bad">${esc(failuresInARow(subject))}, backing off</span>`,
      subject.lastError && `<span class="bad">${esc(subject.lastError)}</span>`,
    ].filter(Boolean).join('');
  };

  const hideTip = () => tip.classList.remove('show');

  /**
   * The token nearest the pointer, within 11px, in the tooltip beside it: on a mouse's move, or
   * a tap, there being no hover under a finger
   *
   * Flipped near the right edge so the tooltip never leaves the panel.
   */
  const hover = (event) => {
    const box = canvas.getBoundingClientRect();
    const mx = event.clientX - box.left;
    const my = event.clientY - box.top;

    let best = null;
    let bestDistance = 11;

    for (const point of plotted) {
      const distance = Math.hypot(point.x - mx, point.y - my);

      if (distance < bestDistance) {
        bestDistance = distance;
        best = point;
      }
    }

    if (!best) {
      hideTip();
      return;
    }

    dom.swap(tip, tipOf(best.subject, best.key, best.m));
    tip.classList.add('show');

    const left = best.x + 14 + tip.offsetWidth > box.width ? best.x - 14 - tip.offsetWidth : best.x + 14;

    tip.style.left = `${Math.max(0, left)}px`;
    tip.style.top = `${Math.max(0, best.y - tip.offsetHeight - 10)}px`;
  };

  canvas.addEventListener('pointermove', hover);
  canvas.addEventListener('pointerdown', hover);
  canvas.addEventListener('pointerleave', hideTip);

  /**
   * How much of the queue the track is drawing, said only when it is not all of it: a silent
   * cap reads as "this is everything".
   */
  const drawUnit = () => {
    const queued = [...ops.queue.shape.sync, ...ops.queue.shape.poll].reduce((all, count) => all + count, 0);
    const shown = ops.queue.subjects.sync.length + ops.queue.subjects.poll.length;

    dom.text($('o-queue-unit'), shown < queued ? `showing the next ${fmt.n(shown)} of ${fmt.n(queued)} queued` : '');
  };

  /**
   * One frame: no drift of its own, every token's position being computed from its absolute due
   * time against the server's clock, so the movement IS the passage of time and a tab left in
   * the background resumes in the right place instead of catching up. Drawn only while the tab
   * shows.
   */
  const frame = () => {
    if (Dash.state.tab === 'ops') draw();

    requestAnimationFrame(frame);
  };

  // Continuous drift is the whole idea, so it is the one thing reduced motion switches off: the
  // same positions, redrawn once a second by tick() instead of on every frame.
  if (!reduceMotion) requestAnimationFrame(frame);

  /** The next twelve, in the fold under the track. */
  const drawNext = () => {
    dom.swap($('o-next'), ops.next.length === 0
      ? `<li>${ui.nothing('Nothing is waiting to be claimed.')}</li>`
      : ops.next.map((subject, i) => `<li><span class="q-rank">${fmt.n(i + 1)}</span>`
        + `<span class="q-kind ${cls(VOCAB.HUES, subject.kind)}">${esc(subject.kind)}</span>`
        + `<span class="grow"><span class="name">${esc(subject.label)}</span>`
        + `<span class="meta">${ui.fragments([tierWord(subject), dueText(subject),
          ...(subject.errors > 0 ? [failuresInARow(subject)] : [])].map(esc))}</span>`
        + `</span></li>`).join(''));
  };

  /* ---- what the machine takes ----------------------------------------------- */

  const drawSubjects = () => {
    const claim = oldestClaim();

    dom.text($('o-capacity-sub'), `${fmt.plural(sum('tracked'), 'subject', 'subjects')} tracked`);
    ui.stackedBar($('o-capacity'), {
      title: 'Subjects',
      segments: [
        { key: 'ontime', label: 'on schedule', n: sum('onSchedule') },
        { key: 'overdue', label: 'overdue', n: sum('overdue') },
        { key: 'claimed', label: 'claimed', n: sum('claimed'), note: claim ? `oldest ${claim}` : undefined },
        { key: 'backoff', label: 'in backoff', n: sum('backoff') },
      ],
      empty: { fact: 'Nothing tracked.' },
    });
  };

  const drawLatency = () => {
    const { from, days, points, window } = ops.latency;
    const over = fmt.plural(days, 'day', 'days');
    // Over the whole window, each only once its own sample is large enough. The p99 has no line
    // of its own: it is a note.
    const level = (key) => stats.gate(key, window[key], window.n);

    dom.text($('o-latency-sub'), `From merge to record, ${fmt.plural(window.n, 'record', 'records')} over ${over}`);

    ui.dotChart($('o-latency'), {
      from,
      days,
      label: 'Latency',
      unit: 'duration',
      points: points.map((point) => ({ at: point.at, value: point.seconds })),
      dot: 'one merge',
      levels: [
        { key: 'p50', label: 'p50', value: level('p50') },
        { key: 'p90', label: 'p90', value: level('p90'), dash: true },
      ],
      notes: level('p99') === null ? [] : [`p99 ${fmt.seconds(level('p99'))}`],
      empty: { fact: `No merge recorded in the last ${over}.` },
    });
  };

  /* ---- recent runs ---------------------------------------------------------- */

  /**
   * A run's counters, in the order the job declared them, zeros kept
   *
   * Numbers only. job_runs.counters is jsonb written by whatever version of the app was
   * running, so a key whose value is not a number is a row from another era.
   */
  const counters = (values) => {
    const reported = Object.entries(values ?? {})
      .filter(([, value]) => Number.isFinite(value))
      // A no-break space: a narrow row breaks between two counters, never inside one.
      .map(([key, value]) => `${key}\u00a0${fmt.n(value)}`);

    return reported.length > 0 ? reported : ['no counter reported'];
  };

  const drawRuns = () => {
    dom.text($('o-runs-sub'), `Last ${fmt.plural(ops.runs.length, 'run', 'runs')}, idle runs left out`);

    ui.filteredList($('o-runs'), {
      id: 'o-runs',
      noun: ['run', 'runs'],
      rows: ops.runs,
      key: (run) => `${run.job}:${run.startedAt}`,
      facets: [{
        key: 'outcome', label: 'Outcome', values: [{ value: 'failed', label: 'failed' }],
        of: (run) => (run.outcome === 'failed' ? 'failed' : 'other'),
      }],
      render: (run) => `<span class="run-at">${esc(fmt.time(run.startedAt))}</span>`
        + `<span class="grow"><span class="name">${esc(run.job)}</span>`
        + `<span class="meta">${ui.fragments([fmt.span(run.durationMs), ...counters(run.counters)].map(esc))}</span>`
        + `${run.outcome === 'failed' && run.error ? `<span class="cause">${esc(run.error)}</span>` : ''}</span>`
        + `<span class="pill ${cls(VOCAB.RUN_OUTCOMES, run.outcome)}">${esc(run.outcome)}</span>`,
      empty: { fact: 'No run recorded yet.' },
      none: `No failed run among the last ${fmt.n(ops.runs.length)}.`,
    });
  };

  /* ---- the accounts --------------------------------------------------------- */

  const USERS = {
    facets: [{
      key: 'state', label: 'State',
      values: VOCAB.ACCOUNT_STATES.map((state) => ({ value: state, label: state })),
      of: (user) => user.state,
    }],
  };

  /** How long since an account left the installed state, or null while it is in it. */
  const stuckMs = (user) => (user.state === 'installed' || !user.stateSince ? null : Dash.now() - Date.parse(user.stateSince));

  const stuckFor = (user) => {
    const ms = stuckMs(user);

    return ms === null ? '—' : user.state === 'pending' ? `enrolled ${fmt.span(ms)}` : fmt.span(ms);
  };

  // The sortable columns, each with what it sorts on. A row with no value sorts last, whichever
  // the direction.
  const SORTS = {
    account: (user) => user.login.toLowerCase(),
    stuck: stuckMs,
    prs: (user) => user.pullRequests,
    merged: (user) => user.merged,
  };

  // Each header aligned as its column is: the figures and the button on the right.
  const COLUMNS = [
    { label: 'Account', sort: 'account' }, { label: 'State' }, { label: 'Stuck for', sort: 'stuck', align: 'num' },
    { label: 'Enrolled', align: 'num' }, { label: 'PR', sort: 'prs', align: 'num' }, { label: 'Merged', sort: 'merged', align: 'num' },
    { label: 'Last sync', align: 'num' }, { label: 'Action', align: 'act' },
  ];

  const ARROWS = { ascending: '↑', descending: '↓' };

  const userRow = (user) => {
    const yours = user.login.toLowerCase() === String(Dash.snapshot.viewer).toLowerCase();

    return `<tr${yours ? ' class="yours"' : ''}>`
      + `<td><div class="who-cell">${marks.face(user.login, 24, user.userId)}<div><div>${esc(user.login)}${yours ? marks.chip('you') : ''}</div>`
      + `<div class="mail">${esc(user.email ?? 'no verified address')}</div></div></div></td>`
      + `<td><span class="acct-state ${cls(VOCAB.ACCOUNT_STATES, user.state)}">${esc(user.state)}</span>`
      + `${user.disabledReason ? `<div class="mail">${esc(user.disabledReason)}</div>` : ''}</td>`
      + `<td class="num">${esc(stuckFor(user))}</td>`
      + `<td class="num">${esc(fmt.date(user.enrolledAt))}</td>`
      + `<td class="num">${fmt.n(user.pullRequests)}</td>`
      + `<td class="num">${fmt.n(user.merged)}</td>`
      + `<td class="num">${esc(user.lastSyncedAt ? fmt.ago(user.lastSyncedAt) : 'never')}</td>`
      // Offered only where it would do something: forcing a state the claim query excludes
      // parks a row at the head of a queue no run will ever drain.
      + `<td class="act">${user.state === 'installed'
        ? `<button type="button" class="force" data-force="${esc(user.userId)}" data-focus-key="${esc(`force:${user.userId}`)}">Force sync</button>`
        : ''}</td>`
      + `</tr>`;
  };

  /**
   * The accounts, through the search, the state chips and the sort, a page at a time
   *
   * The chips count over everybody, whatever the search says. The box, the table's scroll, the
   * chips' state and the page all outlive a refresh: the first two are never redrawn, the last
   * two are in Dash.state.
   */
  const drawUsers = () => {
    const state = (Dash.state.lists['o-users'] ??= { facets: {}, page: 0 });
    const sort = (Dash.state.sort['o-users'] ??= { key: 'account', dir: 'ascending' });
    const users = ops.users;

    dom.text($('o-users-sub'), fmt.plural(users.length, 'account', 'accounts'));

    if (users.length === 0) {
      for (const part of ['filters', 'head', 'rows', 'pages']) dom.swap($(`o-users-${part}`), '');
      dom.swap($('o-users-none'), ui.nothing('Nobody has enrolled yet.'));
      ui.counter($('o-users-count'), 0, 0, '');
      return;
    }

    const picked = Dash.list.select(users, USERS, state);
    const wanted = $('o-users-q').value.trim().toLowerCase();
    const value = SORTS[sort.key];
    const rows = picked.rows
      .filter((user) => !wanted || user.login.toLowerCase().includes(wanted) || (user.email ?? '').toLowerCase().includes(wanted))
      .sort((a, b) => {
        const [x, y] = [value(a), value(b)];

        if (x === null || y === null) return (x === null) - (y === null);

        return (x < y ? -1 : x > y ? 1 : 0) * (sort.dir === 'ascending' ? 1 : -1);
      });

    dom.swap($('o-users-filters'), ui.filters(USERS.facets, picked.counts, state));
    dom.swap($('o-users-head'), `<tr>${COLUMNS.map((column) => {
      const sorted = column.sort === sort.key;

      return `<th${sorted ? ` aria-sort="${sort.dir}"` : ''}${column.align ? ` class="${column.align === 'num' ? 'num' : 'act'}"` : ''}>${column.sort
        ? `<button type="button" data-sort="${column.sort}" data-focus-key="sort:${column.sort}">${esc(column.label)}`
          + `${sorted ? `<span aria-hidden="true"> ${ARROWS[sort.dir]}</span>` : ''}</button>`
        : esc(column.label)}</th>`;
    }).join('')}</tr>`);
    const { from, to } = ui.pages($('o-users-pages'), state, rows.length, drawUsers);

    dom.swap($('o-users-rows'), rows.slice(from, to).map(userRow).join(''));
    dom.swap($('o-users-none'), rows.length === 0 ? ui.nothing('No account matches these filters.') : '');
    ui.counter($('o-users-count'), rows.length, users.length, users.length === 1 ? 'account' : 'accounts');
  };

  /** Another search, chip or sort lists other accounts, or another order of them: from the first page. */
  const drawUsersAnew = () => {
    Dash.state.lists['o-users'].page = 0;
    drawUsers();
  };

  $('o-users-q').addEventListener('input', drawUsersAnew);

  $('o-users-filters').addEventListener('click', (event) => {
    const button = event.target?.closest?.('button');
    const facet = button?.closest('[data-facet]');

    if (facet) {
      Dash.state.lists['o-users'].facets[facet.dataset.facet] = button.dataset.value;
      drawUsersAnew();
    }
  });

  /**
   * Give the focus back to a control a refusal enabled again
   *
   * Disabled while it had the focus, it dropped the focus to the page: to try again would take
   * a Shift+Tab, and a screen reader would hear neither the refusal nor the button. Unless the
   * reader has moved on since, whose place is kept.
   */
  const refocus = (control) => {
    if (!document.activeElement || document.activeElement === document.body) control.focus({ preventScroll: true });
  };

  /**
   * The table's two controls: a header sorts, and Force sync brings one account's next sync
   * forward
   *
   * Bound on the table, not on the buttons: the rows are redrawn whenever a snapshot changes
   * them. What the click wrote on the button stays until its row is next drawn differently, so
   * a refusal leaves it enabled, to be tried again.
   */
  $('o-users').addEventListener('click', async (event) => {
    const header = event.target?.closest?.('button[data-sort]');

    if (header) {
      const sort = Dash.state.sort['o-users'];

      Dash.state.sort['o-users'] = {
        key: header.dataset.sort,
        dir: sort.key === header.dataset.sort && sort.dir === 'ascending' ? 'descending' : 'ascending',
      };
      drawUsersAnew();
      return;
    }

    const button = event.target?.closest?.('button[data-force]');

    if (!button || button.disabled) {
      return;
    }

    button.disabled = true;
    button.textContent = 'Queueing';

    try {
      const response = await fetch(`/dashboard/users/${encodeURIComponent(button.dataset.force)}/sync`, {
        method: 'POST',
        headers: { Accept: 'application/json' },
      });

      if (!response.ok) {
        button.textContent = response.status === 409 ? 'Not syncable' : 'Refused';
        button.disabled = false;
        refocus(button);
        return;
      }

      button.textContent = 'Queued';
      await Dash.refresh();
    } catch {
      // Same treatment as a refusal: from here a dropped connection and a rejected write
      // are one event - the sync was not brought forward.
      button.textContent = 'Refused';
      button.disabled = false;
      refocus(button);
    }
  });

  /* ---- recording a contribution by hand -------------------------------------- */

  let manual = null;
  let manualInFlight = false;
  let manualForge = 'github';
  let manualFound = null;

  const PLACEHOLDER = {
    github: 'https://github.com/owner/repo/pull/123',
    gitlab: 'https://gitlab.com/group/project/-/merge_requests/123',
  };

  /** The enrolled, for the GitLab author picker. Never a free-text field - that is the whole point. */
  const enrolledLogins = () => ops.users
    .filter((user) => user.state === 'installed')
    .map((user) => user.login)
    .sort((a, b) => a.localeCompare(b));

  const manualSay = (kind, message) =>
    `<div class="said ${kind === 'good' ? 'good' : 'bad'}">${esc(message)}</div>`;

  /** What a lookup read off the forge, as a row of facts: the four both forges answer, then `more`. */
  const facts = (f, more = []) => `<dl class="found-facts">${[
    ['merged', fmt.date(f.mergedAt)],
    ['commits', fmt.n(f.commits)],
    ['files', fmt.n(f.changedFiles)],
    ['stars', fmt.n(f.stars)],
    ...more,
  ].map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(String(v))}</dd></div>`).join('')}</dl>`;

  /**
   * What the lookup found, and what may be done with it
   *
   * Two shapes, because the two forges answer differently: GitHub returns the pull request, so
   * this is a confirmation; GitLab returns only what the address itself carried, so this is a
   * form. The refusal has no override on either - a gate that a form can talk its way past is
   * not a gate.
   *
   * Written straight into the box rather than through swap(): it holds a form, written once
   * per lookup, and nothing redraws it.
   */
  const renderFound = () => {
    const box = $('m-result');

    if (!manualFound) {
      box.innerHTML = '';
      return;
    }

    if (manualFound.forge === 'gitlab') {
      const logins = enrolledLogins();
      const f = manualFound;

      // The one field a forge cannot answer. A merge request carries a GitLab username and
      // enrollment is keyed on a GitHub login: the same person under two names, with nothing
      // joining them. Pre-selected only on an exact match, and never defaulted to whoever
      // happens to sort first - that is how the wrong person gets credited by a single click.
      const guess = logins.find((login) => login.toLowerCase() === (f.author ?? '').toLowerCase());
      const picker = `<div class="wide"><label for="g-author">Credit to — enrolled accounts only</label>`
        + `<select id="g-author"><option value="">— choose an account —</option>${logins.map((login) =>
          `<option${login === guess ? ' selected' : ''}>${esc(login)}</option>`).join('')}</select></div>`;

      box.innerHTML = `<div class="found">`
        + `<div class="found-head">${f.needsTyping
          ? 'From the address: this forge could not be read'
          : 'Fetched from GitLab: confirm who to credit'}</div>`
        + `<div class="found-body">`
        + `${f.needsTyping ? '' : `<p class="found-title">${esc(f.title ?? '')}</p>`}`
        + `<p class="found-repo">${esc(f.fullName)} <span class="num">${esc(fmt.num(f.number, 'gitlab'))}</span></p>`
        + `${f.needsTyping
          ? `<div class="fields">${picker}`
            + `<div class="wide"><label for="g-title">Title</label><input id="g-title" type="text"></div>`
            + `<div><label for="g-opened">Opened on</label><input id="g-opened" type="date"></div>`
            + `<div><label for="g-merged">Merged on</label><input id="g-merged" type="date"></div>`
            + `<div><label for="g-commits">Commits</label><input id="g-commits" type="number" min="0"></div>`
            + `<div><label for="g-files">Files changed</label><input id="g-files" type="number" min="0"></div>`
            + `<div><label for="g-stars">Project stars</label><input id="g-stars" type="number" min="0"></div>`
            + `</div>`
          : `${facts(f)}<div class="found-author"><span class="grow">`
            + `<span class="name">${esc(f.authorName ?? f.author ?? 'unknown')}${
              f.author ? ` <span class="num">@${esc(f.author)}</span>` : ''}</span>`
            + `<span class="meta">author, as GitLab reports it — not a GitHub login</span></span></div>`
            + `<div class="fields">${picker}</div>`}`
        + `<div class="acts"><button class="record gitlab" type="button" id="m-save">Record this contribution</button></div>`
        + `</div></div>`;

      if (logins.length === 0) {
        box.insertAdjacentHTML('beforeend',
          manualSay('bad', 'No enrolled account to credit, so nothing can be recorded.'));
      }

      return;
    }

    const f = manualFound;

    box.innerHTML = `<div class="found${f.enrolled ? '' : ' refused'}">`
      + `<div class="found-head">Fetched from GitHub${f.enrolled ? '' : ': refused'}</div>`
      + `<div class="found-body">`
      + `<p class="found-title">${esc(f.title ?? '')}</p>`
      + `<p class="found-repo">${esc(f.fullName)} <span class="num">${esc(fmt.num(f.number, 'github'))}</span></p>${facts(f, [['merged by', f.mergedBy ?? '—']])}`
      + `<div class="found-author">${marks.face(f.author, 32, f.authorId)}<span class="grow"><span class="name">${esc(f.author ?? 'unknown')}</span>`
      + `<span class="meta">author, as GitHub reports it</span></span>`
      + `<span class="verdict ${f.enrolled ? 'yes' : 'no'}">${f.enrolled ? 'enrolled' : 'not enrolled'}</span>`
      + `</div>${
        f.enrolled
          ? `<div class="acts"><button class="record" type="button" id="m-save">Record this contribution</button></div>`
          : manualSay('bad', `Nothing is recorded. This was opened by somebody who has never `
          + `installed the app, so it is not one of our contributions.`)
      }</div></div>`;
  };

  /** Every row an operator recorded, and the only rows on this page a human can remove. */
  const drawManual = () => {
    if (manual === null) return;

    ui.filteredList($('m-list'), {
      id: 'm-list',
      noun: ['contribution', 'contributions'],
      rows: manual,
      key: (row) => String(row.pullRequestId),
      facets: [{
        key: 'forge', label: 'Forge', values: [{ value: 'github', label: 'GitHub' }, { value: 'gitlab', label: 'GitLab' }],
        of: (row) => row.forge,
      }],
      render: (row) => `${marks.forge(row.forge)}<span class="grow">${ui.name(row.url, row.title ?? '')}`
        + `<span class="meta">${ui.fragments([esc(`${row.repo} ${fmt.num(row.number, row.forge)}`), esc(`merged ${fmt.date(row.mergedAt)}`),
          `${marks.face(row.login, 20)}${esc(row.login)}`,
          ...(row.commits === null ? [] : [esc(fmt.plural(row.commits, 'commit', 'commits'))])])}</span></span>`
        + `<button type="button" class="drop" data-drop="${esc(row.pullRequestId)}" data-focus-key="${esc(`drop:${row.pullRequestId}`)}">Remove</button>`,
      empty: { fact: 'Nothing recorded by hand.' },
    });
  };

  const loadManual = async () => {
    if (Dash.signedOut || manualInFlight) {
      return;
    }

    manualInFlight = true;

    let rows = null;

    try {
      const response = await fetch('/dashboard/manual', {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });

      if (response.ok) {
        rows = (await response.json()).contributions ?? [];
      }
    } catch {
      // Answered below, as a refusal is: from here the two are one event.
    } finally {
      manualInFlight = false;
    }

    // Outside the try: a throw here is a bug in the list, not a failed read.
    if (rows) {
      manual = rows;
      drawManual();
    } else if (!$('m-list-rows')) {
      // Only while the list has never been drawn, whose parts are written once: a list already
      // on the page stays as it was read.
      dom.swap($('m-list'), ui.nothing('Could not read what was recorded by hand.'));
    }
  };

  /** One call for both writes, so a refusal reads the same wherever it came from. */
  const manualPost = async (path, body, method = 'POST') => {
    const response = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      cache: 'no-store',
      body: body === null ? undefined : JSON.stringify(body),
    });

    const payload = await response.json().catch(() => ({}));

    return { ok: response.ok, error: payload.error ?? 'the request failed' };
  };

  // An address edited is not the one looked up: its preview goes, and the Record button with it,
  // so what was found for one address is never on screen under another.
  $('m-url').addEventListener('input', () => {
    manualFound = null;
    renderFound();
  });

  /* ---- recording by hand: the three writes ------------------------------------ */

  $('view-ops').addEventListener('click', async (event) => {
    const target = event.target;

    // Switching forge clears what was found: a GitLab form left standing under a GitHub
    // address is how somebody records one thing believing it is another.
    const pick = target?.closest?.('[data-forge]');

    if (pick) {
      manualForge = pick.dataset.forge;
      manualFound = null;
      renderFound();
      $('m-url').placeholder = PLACEHOLDER[manualForge];
      $('m-url').value = '';

      for (const forge of Object.keys(PLACEHOLDER)) {
        $(`m-${forge}`).setAttribute('aria-pressed', String(forge === manualForge));
      }

      return;
    }

    if (target?.id === 'm-look') {
      target.disabled = true;

      const url = $('m-url').value;

      try {
        const response = await fetch('/dashboard/manual/lookup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          cache: 'no-store',
          body: JSON.stringify({ url }),
        });
        const payload = await response.json().catch(() => ({}));

        // Edited while the answer was on its way: that answer is for an address the box no
        // longer holds, and drawing it would put one preview under another address.
        if ($('m-url').value !== url) {
          return;
        }

        if (!response.ok) {
          manualFound = null;
          $('m-result').innerHTML = manualSay('bad', payload.error ?? 'the lookup failed');
          return;
        }

        manualFound = payload;
        renderFound();
      } catch {
        manualFound = null;
        $('m-result').innerHTML = manualSay('bad', 'the lookup could not be sent');
      } finally {
        target.disabled = false;
      }

      return;
    }

    if (target?.id === 'm-save') {
      target.disabled = true;
      target.textContent = 'Recording';

      // The address that was looked up, not whatever the box holds now: the author picked and
      // the fields typed were chosen for the preview on screen, and sent with another address
      // they would credit one merge request with another's author. Only the address is sent
      // rather than the whole preview: the server fetches it once more and writes from THAT, so
      // nothing a page could have altered reaches a row.
      const body = { url: manualFound.url };

      if (manualFound?.forge === 'gitlab') {
        // The author travels on both paths, because it is the one thing no forge can answer.
        // The rest travels only when nobody could read it: where GitLab did answer, the server
        // asks it again and writes from that, so there is nothing for this page to send.
        body.author = $('g-author')?.value;

        if (manualFound.needsTyping) {
          Object.assign(body, {
            title: $('g-title')?.value,
            openedAt: $('g-opened')?.value,
            mergedAt: $('g-merged')?.value,
            commits: $('g-commits')?.value,
            changedFiles: $('g-files')?.value,
            stars: $('g-stars')?.value,
          });
        }
      }

      const { ok, error } = await manualPost('/dashboard/manual', body);

      if (!ok) {
        target.disabled = false;
        target.textContent = 'Record this contribution';
        refocus(target);
        $('m-result').insertAdjacentHTML('beforeend', manualSay('bad', error));
        return;
      }

      manualFound = null;
      $('m-url').value = '';
      $('m-result').innerHTML = manualSay('good', 'Recorded. It counts from the next report onwards.');
      manual = null;
      manualInFlight = false;
      await loadManual();

      return;
    }

    const drop = target?.closest?.('[data-drop]');

    if (drop && !drop.disabled) {
      // The row goes with its button: the focus moves to the next row's, or the previous one's,
      // rather than falling back to the top of the page.
      const row = drop.closest('li');
      const then = (row?.nextElementSibling ?? row?.previousElementSibling)?.querySelector('[data-drop]')?.dataset.drop;

      drop.disabled = true;
      drop.textContent = 'Removing';

      const { ok } = await manualPost(`/dashboard/manual/${encodeURIComponent(drop.dataset.drop)}`, null, 'DELETE');

      if (!ok) {
        drop.disabled = false;
        drop.textContent = 'Refused';
        refocus(drop);
        return;
      }

      manual = null;
      manualInFlight = false;
      await loadManual();

      if (then) [...$('m-list-rows').querySelectorAll('[data-drop]')].find((button) => button.dataset.drop === then)?.focus();
    }
  });

  /* ---- what the bot has recorded --------------------------------------------- */

  /**
   * The machine's inventory as production's two columns of rows: a label, and its figure on
   * the right with what it splits into beside it. Every table counted whole, bots included.
   * Null is a read that failed, which the notice names; every count zero is an empty database.
   */
  const drawInventory = () => {
    const inv = ops.inventory;

    if (!inv) {
      dom.swap($('o-inventory'), ui.nothing('The inventory could not be read.'));
      return;
    }

    const events = inv.pullRequestEvents + inv.pushEvents;
    const counts = [inv.pullRequests, inv.repositories, inv.accounts, events, inv.renames];

    if (counts.every((count) => count === 0)) {
      dom.swap($('o-inventory'), ui.nothing('Nothing recorded yet.'));
      return;
    }

    const rows = [
      ['Pull requests recorded', fmt.n(inv.pullRequests), `${fmt.n(inv.byPeople)} by people, ${fmt.n(inv.byBots)} by bots`],
      ['Merged', fmt.n(inv.merged)],
      ['Commits in those pull requests', fmt.n(inv.commits)],
      ['Repositories tracked', fmt.n(inv.repositories), `${fmt.n(inv.repositoriesOurs)} ours`],
      ['Distinct authors', fmt.n(inv.authors)],
      ['Accounts enrolled', `${fmt.n(inv.accountsActive)} / ${fmt.n(inv.accounts)}`, 'active / ever'],
      ['Events processed', fmt.n(events), `${fmt.n(inv.pullRequestEvents)} pull request, ${fmt.n(inv.pushEvents)} push`],
      ['Recorded by hand', fmt.n(inv.byHand)],
      ['Repository renames detected', fmt.n(inv.renames)],
      ['Collecting since', fmt.date(inv.since)],
      ['Added in the last 7 days', fmt.n(inv.lastWeek)],
    ];
    const half = Math.ceil(rows.length / 2);
    const column = (part) => `<dl class="inventory-col">${part.map(([label, value, share]) => '<div class="inventory-row">'
      + `<dt>${esc(label)}</dt><dd>${share ? `<span class="inventory-share">${esc(share)}</span>` : ''}${esc(value)}</dd></div>`).join('')}</dl>`;

    dom.swap($('o-inventory'), `<div class="inventory">${column(rows.slice(0, half))}${column(rows.slice(half))}</div>`);
  };

  /* ---- the settings --------------------------------------------------------- */

  /** A setting's value as a chip: a number in its unit, anything else as it was read. */
  const settingValue = (unit, value) => {
    if (unit === 'minutes') return fmt.tier(value);
    if (unit === 'days') return fmt.plural(value, 'day', 'days');
    if (unit === 'subjects') return fmt.plural(value, 'subject', 'subjects');

    return String(value);
  };

  /**
   * What the process was started with: a row per group, each setting its label, its values and
   * the variables it is read from. An empty list says so in a dashed chip rather than showing
   * nothing, which would read as not loaded.
   */
  const drawSettings = () => dom.swap($('o-settings'), ops.settings.map((group) => '<div class="settings-row">'
    + `<p class="settings-head">${esc(group.title)}</p><div class="settings">${group.items.map((item) => '<div class="setting">'
      + `<span class="setting-label">${esc(item.label)}</span><div class="setting-values">${item.values.length > 0
        ? item.values.map((value) => `<span>${esc(settingValue(item.unit, value))}</span>`).join('')
        : `<span class="none">${esc(item.none)}</span>`}</div>`
      + `<span class="setting-env">${item.env.map((name) => `<code>${esc(name)}</code>`).join(' ')}</span></div>`).join('')}</div></div>`)
    .join(''));

  /* ---- the tab ------------------------------------------------------------- */

  /** What moves with the clock alone, redrawn each second: a no-op where nothing changed. */
  const tick = () => {
    drawTiles();
    drawSubjects();
    clocks();
    if (reduceMotion) draw();
  };

  const render = () => {
    drawJobs();
    drawUnit();
    drawNext();
    drawLatency();
    drawRuns();
    drawUsers();
    drawManual();
    drawInventory();
    drawSettings();
    tick();
  };

  const snapshot = (fresh) => {
    ops = fresh.ops;

    // A tick is detected from the data rather than guessed from the clock: when the newest run
    // that did something changes, a job has just drained part of the queue, and the line flashes.
    const stamp = ops.runs[0]?.startedAt ?? '';

    if (lastRunStamp && stamp !== lastRunStamp && !reduceMotion) flashUntil = performance.now() + 900;

    lastRunStamp = stamp;
    hideTip();

    // The footer's, so written whichever tab is showing.
    dom.text($('f-uptime'), `up ${fmt.span(ops.app.uptimeMs)}`);
    dom.text($('f-rev'), `revision ${ops.app.revision}`);
  };

  snapshot(Dash.snapshot);

  Dash.tab('ops', {
    activate() {
      render();
      loadManual();
    },
    render,
    snapshot,
    tick,
  });
})();
