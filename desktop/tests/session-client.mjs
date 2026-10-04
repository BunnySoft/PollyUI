document.body.style.backgroundColor = '#203040';
document.body.textContent = 'PollyDesktop development session';
if (application.id !== 'org.pollyui.shell') throw new Error('Unexpected shell application identity');
if (application.arguments[0] === 'hold') {
    setInterval(() => {}, 100);
} else {
    if (application.arguments[0] !== 'argument with spaces' ||
        application.arguments[1] !== '; not a shell command') throw new Error('Session arguments were changed');
    requestAnimationFrame(() => setTimeout(() => {
        console.log('PASS: development session arguments and identity');
        window.close();
    }, 150));
}
