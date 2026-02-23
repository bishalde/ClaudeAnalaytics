// Nav scroll effect
window.addEventListener('scroll', () => {
  document.querySelector('.nav').classList.toggle('scrolled', window.scrollY > 40);
});

// Copy command
function copyCmd(btn) {
  navigator.clipboard.writeText('npx claude-spend').then(() => {
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
  });
}

// Scroll reveal
const observer = new IntersectionObserver(entries => {
  entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('visible'); observer.unobserve(e.target); } });
}, { threshold: 0.1 });
document.querySelectorAll('.reveal').forEach(el => observer.observe(el));

// Animated mock bars
function animateBars() {
  const bars = document.querySelectorAll('.mock-bar');
  bars.forEach((bar, i) => {
    const h = 20 + Math.random() * 80;
    bar.style.setProperty('--h', h + '%');
    bar.style.height = h + '%';
    bar.style.animationDelay = (i * 0.05) + 's';
  });
}
animateBars();
setInterval(() => {
  const bars = document.querySelectorAll('.mock-bar');
  bars.forEach(bar => {
    const h = 20 + Math.random() * 80;
    bar.style.transition = 'height 1s ease';
    bar.style.height = h + '%';
  });
}, 4000);
