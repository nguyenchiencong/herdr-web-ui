### Fixed
- Stopping the Windows plugin reads the process table once more when the first read fails, within
  the stop timeout; it still refuses to stop a server it cannot verify if that read fails too.
