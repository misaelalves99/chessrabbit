# Security Policy

## Supported versions

Security fixes are handled on the latest public release and the `main` branch. Older prerelease installers may not receive separate patch releases.

## Reporting a vulnerability

Please report security problems privately when possible. Do not open a public issue that includes an exploit, secret, private user data or a working attack path.

Preferred contact options:

- Open a GitHub security advisory for this repository if the option is available.
- If advisories are not available, contact the maintainer through the GitHub profile at https://github.com/shivamjg101 and share only the minimum detail needed to start a private report.

Include:

- A short description of the issue.
- Steps to reproduce.
- The affected version, operating system and install method.
- Whether private data, local files, network access or engine execution is involved.

## Scope

In scope:

- Vulnerabilities in ChessRabbit code, installer scripts or bundled runtime behavior.
- Local privilege, file access, authentication, import parsing, API or engine-management issues caused by ChessRabbit.
- Accidental exposure of secrets in the repository or release assets.

Out of scope:

- Vulnerabilities in unmodified third-party engines, operating systems, browsers, GitHub or external chess services. Report those to the affected project.
- Results from modified builds unless the issue also exists in the official source or release.
- Social engineering, spam or denial-of-service against community spaces.

## Local engine safety

ChessRabbit can run chess engines as local executables. Only add engines you trust, downloaded from their official sources. A UCI engine is a program running on your computer, so it has the same general risk as other downloaded executables.
