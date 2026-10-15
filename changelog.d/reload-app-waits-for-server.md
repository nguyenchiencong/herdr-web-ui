### Fixed
- "Reload app" waits, with its button disabled, up to 10 seconds for the server to answer, and a
  page the server does not answer is asked for again before the offline copy stands in for it. A
  reload that caught a restarting server used to load the previous build from that copy, and its
  "App updated" notice came back; it now waits for the server, unless the server is still down
  after the wait.
