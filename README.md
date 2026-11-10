# Family day display

A calm, large-print kiosk page for a wall tablet: the day, the time of day, the next event, and a current reminder.

- `index.html` is the display. With no settings in its address it shows made-up sample events.
- `relay/worker.js` is a small Cloudflare Worker that reads a private calendar link and passes along only titles and times for today and tomorrow.

The tablet's address supplies the relay location and an access key:

```
https://<this site>/?relay=<worker address>&key=<access key>
```

No calendar links, keys or real names are stored in this repository. Those live as secrets in the Worker and in the tablet's start address.

Add `#test` to the end of the address for a time slider and a chime button.
