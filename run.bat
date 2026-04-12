@echo off
echo Starting local server...
start node server.js
echo.
echo HTTP app URL: http://localhost:3000/mobile.html
echo HTTPS app URL: https://localhost:3443/mobile.html  ^(requires certs\localhost.pem and certs\localhost-key.pem^)
echo Tailscale proxy: tailscale serve 3000
tailscale serve 3000