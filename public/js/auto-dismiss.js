document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('.alert-autodismiss').forEach(function (alert) {
        let count = 5;

        const badge = document.createElement('span');
        badge.textContent = count;
        badge.style.cssText = 'position:absolute;bottom:4px;right:8px;font-size:0.65rem;opacity:0.55;line-height:1;font-variant-numeric:tabular-nums;';
        alert.style.position = 'relative';
        alert.appendChild(badge);

        const interval = setInterval(function () {
            count--;
            badge.textContent = count;

            if (count <= 0) {
                clearInterval(interval);
                alert.style.transition = 'opacity 0.4s';
                alert.style.opacity = '0';
                setTimeout(function () { alert.remove(); }, 400);
            }
        }, 1000);
    });
});
