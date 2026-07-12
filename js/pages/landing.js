/* ============================================================
   IRIBHM Microscopy Platform — Landing Page Logic
   ============================================================
   Animated 3D hero background, stats counters, featured
   datasets, navbar scroll effect, and initialization.
   ============================================================ */

/* ── Initialization ──────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', async () => {
  // Usage telemetry: count one site visit per browser session (fire-and-forget).
  try {
    if (!sessionStorage.getItem('lumen_visit')) {
      sessionStorage.setItem('lumen_visit', '1');
      navigator.sendBeacon?.('api/telemetry.php?action=visit');
    }
  } catch (_) { /* private mode / no beacon — ignore */ }

  // Init core systems. Instance config loads FIRST so I18n.t() can interpolate
  // the brand/specimen tokens and the head/brand reflect the operator's identity.
  await InstanceConfig.load();
  Theme.init();
  await I18n.init();
  InstanceConfig.applyHead();
  InstanceConfig.applyDom();

  // Load catalog
  await Catalog.load();

  // Update theme icon
  updateThemeIcon();
  Theme.onChange(updateThemeIcon);
  // Build the language switcher from the platform's discovered locales.
  Utils.populateLanguageMenu(switchLanguage);

  // Initialize hero animation
  initHeroAnimation();

  // Initialize navbar scroll effect
  initNavbarScroll();

  // Populate stats
  populateStats();

  // Populate featured datasets
  populateFeatured();

  // Initialize Lucide icons
  if (window.lucide) lucide.createIcons();

  // Intersection observer for scroll animations
  initScrollAnimations();

  // White-label: if the operator published a block layout for the home page,
  // render it in place of the default landing.
  await maybeRenderHomeBlocks();

  // Show page
  document.body.classList.add('loaded');
});

/* ── White-label home block override ─────────────────────────── */
function _renderHomeSource(source) {
  const host = document.getElementById('home-blocks');
  const def = document.getElementById('home-default');
  if (!host || typeof PageRenderer === 'undefined') return;
  const n = PageRenderer.renderSource(host, source, { wrap: true });
  if (n) { host.style.display = ''; if (def) def.style.display = 'none'; }
  else { host.style.display = 'none'; if (def) def.style.display = ''; }
  // Operator-authored animated page background (only when the override is live —
  // the default landing keeps its own hero canvas).
  try { if (typeof PageBackground !== 'undefined') PageBackground.apply(n ? source && source.background : null); } catch (_) {}
}

async function maybeRenderHomeBlocks() {
  if (typeof PageRenderer === 'undefined') return;
  const preview = new URLSearchParams(location.search).get('preview') === 'draft';
  // Live-preview bridge for the admin Pages tab (works even with no published content).
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent) return;
    const m = e.data;
    if (m && m.type === 'LUMEN_PREVIEW_DOC' && m.source) _renderHomeSource(m.source);
    else if (m && m.type === 'LUMEN_PREVIEW_BLOCKS' && Array.isArray(m.blocks)) _renderHomeSource({ blocks: m.blocks });
  });
  let source = { sections: [] };
  try { source = await PageRenderer.fetchSource('home', preview); } catch (_) {}
  const has = (source.sections && source.sections.length) || (source.blocks && source.blocks.length);
  if (has) {
    _renderHomeSource(source);
    if (typeof I18n !== 'undefined' && I18n.onLanguageChange) I18n.onLanguageChange(() => _renderHomeSource(source));
  }
}

/* ── Theme Icon ──────────────────────────────────────────── */
function updateThemeIcon() {
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;
  const icon = Theme.isDark() ? 'moon' : 'sun';
  btn.innerHTML = `<i data-lucide="${icon}" style="width:20px;height:20px"></i>`;
  if (window.lucide) lucide.createIcons({ nodes: [btn] });
}

/* ── Dropdown Toggle ─────────────────────────────────────── */
// DEAD-035: global name retained for the inline HTML onclick handlers; the
// implementation lives once in Utils (shared by landing + explorer).
function toggleDropdown(id) {
  Utils.toggleDropdown(id);
}

/* ── Language Switch ─────────────────────────────────────── */
async function switchLanguage(lang) {
  await I18n.setLanguage(lang);
  Utils.closeDropdowns(); // DEAD-035: shared dropdown-close step
  Utils.populateLanguageMenu(switchLanguage); // refresh active-item highlight
  // Page-specific: re-render the featured grid in the new language
  populateFeatured();
}

/* ── Navbar Scroll Effect ────────────────────────────────── */
function initNavbarScroll() {
  const navbar = document.getElementById('navbar');
  if (!navbar) return;

  const check = () => {
    if (window.scrollY > 50) {
      navbar.classList.add('scrolled');
    } else {
      navbar.classList.remove('scrolled');
    }
  };

  window.addEventListener('scroll', Utils.throttle(check, 50), { passive: true });
  check();
}

/* ── Stats Counters ──────────────────────────────────────── */
function populateStats() {
  const stats = Catalog.getStats();

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        Utils.animateCounter(document.getElementById('stat-datasets'), stats.totalDatasets);
        Utils.animateCounter(document.getElementById('stat-embryos'), stats.totalEmbryos);
        Utils.animateCounter(document.getElementById('stat-cells'), stats.totalCells);
        Utils.animateCounter(document.getElementById('stat-regions'), stats.totalRegions);
        observer.disconnect();
      }
    });
  }, { threshold: 0.3 });

  const statsBar = document.getElementById('stats-bar');
  if (statsBar) observer.observe(statsBar);

  // Update type card counts
  const countFixed = document.getElementById('count-fixed');
  const countLive = document.getElementById('count-live');
  const countTracking = document.getElementById('count-tracking');
  if (countFixed) countFixed.textContent = `${stats.byType.fixed} datasets`;
  if (countLive) countLive.textContent = `${stats.byType.live} datasets`;
  if (countTracking) countTracking.textContent = `${stats.byType.tracking} datasets`;
}

/* ── Featured Datasets ───────────────────────────────────── */
function populateFeatured() {
  const grid = document.getElementById('featured-grid');
  if (!grid) return;

  const all = Catalog.getAll();
  const newest = [...all].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const preferred = [
    [...all].filter(d => d.type === 'tracking').sort((a, b) => (b.nCells || 0) - (a.nCells || 0))[0],
    [...all].filter(d => d.type === 'fixed').sort((a, b) => (b.dimensions?.z || 0) - (a.dimensions?.z || 0))[0],
    [...all].filter(d => d.type === 'live').sort((a, b) => (b.dimensions?.c || 0) - (a.dimensions?.c || 0))[0],
  ].filter(Boolean);

  const featured = [];
  [...preferred, ...newest].forEach(d => {
    if (featured.length < 3 && !featured.some(existing => existing.id === d.id)) {
      featured.push(d);
    }
  });

  // PERF-028: single innerHTML write. Non-ASCII glyphs are emitted as HTML
  // entities at the source (see createDatasetCard) so they render correctly
  // regardless of how the host serves the file's charset, removing the need
  // for the former second-pass mojibake repair.
  grid.innerHTML = featured.map((d, i) => createDatasetCard(d, i)).join('');

  if (window.lucide) lucide.createIcons({ nodes: [grid] });
}

/**
 * Create a dataset card HTML
 * @param {object} dataset
 * @param {number} index - for stagger animation
 * @returns {string} HTML
 */
function createDatasetCard(dataset, index = 0) {
  const typeLabels = {
    fixed: I18n.t('explorer.fixed'),
    live: I18n.t('explorer.live'),
    tracking: I18n.t('explorer.tracking')
  };
  const typeClass = {
    fixed: 'badge-fixed',
    live: 'badge-live',
    tracking: 'badge-tracking'
  };
  const typeIcons = {
    fixed: 'layers',
    live: 'video',
    tracking: 'git-branch'
  };

  const stageDisplay = Utils.formatStage(dataset.stage);
  const dateDisplay = Utils.formatDate(dataset.date);
  const sizeDisplay = dataset.fileSize ? Utils.formatFileSize(dataset.fileSize) : '';

  // Build meta info
  const metaItems = [];
  if (stageDisplay !== '—') metaItems.push(`<span>${stageDisplay}</span>`);
  if (dateDisplay !== '—') metaItems.push(`<span>${dateDisplay}</span>`);
  if (dataset.nCells) metaItems.push(`<span>${dataset.nCells} ${I18n.t('tracking.cells').toLowerCase()}</span>`);
  if (dataset.dimensions?.x && dataset.dimensions?.y && dataset.dimensions?.z) {
    const d = dataset.dimensions;
    metaItems.push(`<span>${d.x}&times;${d.y}&times;${d.z}</span>`);
  }

  // Thumbnail placeholder with gradient
  const gradients = {
    fixed: 'linear-gradient(135deg, #00D2FF22, #0F346044)',
    live: 'linear-gradient(135deg, #FFA72622, #16213E44)',
    tracking: 'linear-gradient(135deg, #00A65422, #1A1A2E44)'
  };

  // SEC-015: dataset fields are catalog data — escape before innerHTML (mirrors explorer.js).
  const image = dataset.thumbnail
    ? `<img src="${Utils.escapeHtml(dataset.thumbnail)}" alt="">`
    : `<i data-lucide="${typeIcons[dataset.type]}" style="width:48px;height:48px;color:var(--text-muted);opacity:0.4"></i>`;

  return `
    <a href="${getDatasetUrl(dataset)}" class="card animate-fade-in-up delay-${index + 1}" style="text-decoration:none;color:inherit">
      <div class="card-image" style="background: ${gradients[dataset.type] || gradients.fixed}; display:flex; align-items:center; justify-content:center;">
        ${image}
      </div>
      <div class="card-body">
        <div style="display:flex;align-items:center;gap:var(--space-2);margin-bottom:var(--space-2)">
          <span class="badge badge-dot ${typeClass[dataset.type]}">${typeLabels[dataset.type]}</span>
        </div>
        <div class="card-title">${Utils.escapeHtml(dataset.name)}</div>
        <div class="card-subtitle">${Utils.escapeHtml(dataset.description || '')}</div>
        <div class="card-meta">
          ${metaItems.join('<span style="opacity:0.3">&middot;</span>')}
        </div>
      </div>
    </a>
  `;
}

function getDatasetUrl(dataset) {
  const page = dataset.type === 'tracking' ? 'tracking.html' : 'viewer.html';
  return `${page}?id=${encodeURIComponent(dataset.id)}`;
}

/* ── Scroll Animations ───────────────────────────────────── */
function initScrollAnimations() {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.style.animationPlayState = 'running';
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.1 });

  document.querySelectorAll('.animate-fade-in-up, .animate-fade-in').forEach(el => {
    el.style.animationPlayState = 'paused';
    observer.observe(el);
  });
}

/* ── Hero 3D Animation ───────────────────────────────────── */
function initHeroAnimation() {
  const canvas = document.getElementById('hero-canvas');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  let width, height;
  let particles = [];
  let connections = [];
  let animFrame;
  let mouse = { x: -1000, y: -1000 };

  function resize() {
    width = canvas.width = canvas.offsetWidth * window.devicePixelRatio;
    height = canvas.height = canvas.offsetHeight * window.devicePixelRatio;
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    width = canvas.offsetWidth;
    height = canvas.offsetHeight;
  }

  function createParticles() {
    particles = [];
    const count = Math.min(80, Math.floor((width * height) / 12000));
    for (let i = 0; i < count; i++) {
      particles.push({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.5,
        vy: (Math.random() - 0.5) * 0.5,
        r: Math.random() * 2 + 1,
        color: ['#00A654', '#00D2FF', '#FFA726', '#44FF88'][Math.floor(Math.random() * 4)],
        alpha: Math.random() * 0.5 + 0.2
      });
    }
  }

  function update() {
    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;

      // Bounce
      if (p.x < 0 || p.x > width) p.vx *= -1;
      if (p.y < 0 || p.y > height) p.vy *= -1;

      // Mouse repulsion
      const dx = p.x - mouse.x;
      const dy = p.y - mouse.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 150) {
        const force = (150 - dist) / 150 * 0.02;
        p.vx += dx * force;
        p.vy += dy * force;
      }

      // Dampen velocity
      p.vx *= 0.999;
      p.vy *= 0.999;
    }
  }

  function draw() {
    ctx.clearRect(0, 0, width, height);

    // Draw connections
    // PERF-031: O(n²) per frame — compare squared distance to skip the sqrt for
    // the (vast majority of) pairs that fall outside the connection radius, and
    // only take the sqrt for surviving pairs whose alpha needs the real distance.
    const maxDist = 160;
    const maxDistSq = maxDist * maxDist;
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const dx = particles[i].x - particles[j].x;
        const dy = particles[i].y - particles[j].y;
        const distSq = dx * dx + dy * dy;
        if (distSq < maxDistSq) {
          const dist = Math.sqrt(distSq);
          const alpha = (1 - dist / maxDist) * 0.15;
          ctx.beginPath();
          ctx.moveTo(particles[i].x, particles[i].y);
          ctx.lineTo(particles[j].x, particles[j].y);
          ctx.strokeStyle = `rgba(0, 166, 84, ${alpha})`;
          ctx.lineWidth = 0.5;
          ctx.stroke();
        }
      }
    }

    // Draw particles
    for (const p of particles) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = p.alpha;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  function animate() {
    // PERF-031: skip the O(n²) connection sweep + redraw while the tab is hidden;
    // keep the RAF loop alive so it resumes seamlessly on visibility return.
    if (!document.hidden) {
      update();
      draw();
    }
    animFrame = requestAnimationFrame(animate);
  }

  // Mouse tracking
  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    mouse.x = e.clientX - rect.left;
    mouse.y = e.clientY - rect.top;
  });

  canvas.addEventListener('mouseleave', () => {
    mouse.x = -1000;
    mouse.y = -1000;
  });

  window.addEventListener('resize', Utils.debounce(() => {
    cancelAnimationFrame(animFrame);
    resize();
    createParticles();
    animate();
  }, 200));

  resize();
  createParticles();
  animate();
}
