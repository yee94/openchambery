(() => {
  if ('ResizeObserver' in window) {
    const deviceObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        entry.target.style.setProperty('--device-scale', String(entry.contentRect.width / 428));
      }
    });
    document.querySelectorAll('.phone').forEach((phone) => deviceObserver.observe(phone));
  }

  document.querySelectorAll('[data-switcher]').forEach((group) => {
    const buttons = [...group.querySelectorAll('[data-choice]')];
    const panels = [...group.querySelectorAll('[data-panel]')];
    const status = group.querySelector('.preview-status');
    let request = 0;
    const select = async (button) => {
      const current = ++request;
      const images = panels.filter((panel) => panel instanceof HTMLImageElement && panel.dataset.panel === button.dataset.choice);
      const pending = images.filter((image) => !image.complete || !image.naturalWidth);
      if (pending.length) {
        group.setAttribute('aria-busy', 'true');
        status.textContent = group.dataset.loading;
        status.hidden = false;
        try {
          await Promise.all(pending.map((image) => {
            image.loading = 'eager';
            if (image.complete && !image.naturalWidth) {
              const source = image.getAttribute('src');
              image.src = source;
            }
            return image.decode();
          }));
        } catch {
          if (current !== request) return;
          group.removeAttribute('aria-busy');
          status.textContent = group.dataset.error;
          return;
        }
      }
      if (current !== request) return;
      group.removeAttribute('aria-busy');
      status.hidden = true;
      buttons.forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
      panels.forEach((panel) => { panel.hidden = panel.dataset.panel !== button.dataset.choice; });
    };
    buttons.forEach((button, index) => {
      button.addEventListener('click', () => select(button));
      button.addEventListener('keydown', (event) => {
        let next;
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % buttons.length;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + buttons.length) % buttons.length;
        if (event.key === 'Home') next = 0;
        if (event.key === 'End') next = buttons.length - 1;
        if (next === undefined) return;
        event.preventDefault();
        buttons[next].focus();
        select(buttons[next]);
      });
    });
  });

  const scene = document.querySelector('.connection');
  const motion = window.matchMedia('(min-width: 1000px) and (min-height: 740px) and (prefers-reduced-motion: no-preference)');
  let frame = 0;
  let start = 0;
  let distance = 1;
  let previous = -1;
  const update = () => {
    frame = 0;
    const progress = Math.max(0, Math.min(1, (window.scrollY - start) / distance));
    if (progress === previous) return;
    previous = progress;
    scene.style.setProperty('--progress', progress.toFixed(4));
  };
  const onScroll = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };
  const measure = () => {
    start = scene.getBoundingClientRect().top + window.scrollY - 72;
    distance = Math.max(1, scene.offsetHeight - (window.innerHeight - 72));
    previous = -1;
    onScroll();
  };
  const configure = () => {
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', measure);
    cancelAnimationFrame(frame);
    frame = 0;
    document.documentElement.classList.toggle('motion', motion.matches);
    if (!motion.matches) {
      scene.style.removeProperty('--progress');
      return;
    }
    measure();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', measure, { passive: true });
  };
  if (scene) {
    motion.addEventListener('change', configure);
    configure();
  }
})();
