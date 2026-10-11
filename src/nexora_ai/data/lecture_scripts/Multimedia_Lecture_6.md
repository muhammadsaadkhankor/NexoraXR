# Lecture 6 — Multimedia Computing: Security

**Course:** Multimedia Computing
**Professor narration script** — each block is one spoken segment (maps 1:1 to slides).

---

## Segment 1 — Welcome Back

Welcome back. Last time we explored digital twins and AI-powered metaverses — rich virtual systems carrying valuable data about real people and real things. Today we ask the obvious follow-up: how do we protect all of it? In Lecture 6, our focus is security — how we verify who someone is, how we keep multimedia data private in transit, and how we protect ownership of digital content. By the end of today you will know the main tools: biometrics, encryption, secure network tunnels, and watermarking. Let's begin.

## Segment 2 — Biometrics: Proving Who You Are

The first problem is identity. Passwords can be shared or stolen, so systems increasingly use biometrics — measuring the person, not the secret. Physical biometrics are body characteristics: fingerprints, iris patterns, face geometry — traits you carry everywhere. Behavioral biometrics are things you do: your voice signature, typing rhythm, gait, or signature dynamics. Both map identity to something hard to forge. The trade-off is privacy — biometric data is deeply personal, which is exactly why securing multimedia content matters so much.

## Segment 3 — Encryption Basics

To keep data private we encrypt it — scrambling content so only someone with the right key can read it. Symmetric encryption uses one shared key for both locking and unlocking — fast and efficient, perfect for bulk media, but both sides must already share the secret. Asymmetric encryption uses a key pair: a public key anyone can use to encrypt or verify, and a private key only the owner holds — slower, but it solves the key-sharing problem and enables digital signatures. Real systems combine them: asymmetric to exchange a session key, symmetric to move the data.

## Segment 4 — Securing the Network: VPNs and IPsec

Encryption must also protect data as it travels. A virtual private network creates a secure tunnel over the public internet — traffic between two points is encapsulated and encrypted so observers see only opaque packets. Under the hood, IPsec provides the machinery: security associations define the protected relationship, authentication headers prove a packet's origin and integrity, and encapsulating security payload encrypts the contents. This is how remote workers, hospitals, and distributed multimedia systems exchange sensitive media safely.

## Segment 5 — Watermarking: Protecting Ownership

Encryption protects content in transit — but once delivered, how do you prove it is yours? Watermarking embeds an invisible marker inside media — an image, video, or audio signal — that survives normal use. The embedding process hides the mark so it does not disturb perception, yet it can be detected later. Watermarking comes in visible and invisible forms, robust and fragile: robust marks survive compression and editing to prove ownership; fragile marks break on tampering to prove integrity. Applications range from copyright protection to tracing leaks.

## Segment 6 — Attacks and the Arms Race

Of course, attackers work to defeat watermarks — geometric attacks like cropping and rotation, signal-processing attacks like filtering and recompression, and removal attempts aimed at the mark itself. Watermark design is an arms race: each attack teaches designers to embed marks more robustly, spreading energy across frequencies and regions so no single operation can strip them. The lesson extends beyond watermarks — every security mechanism we covered today assumes a motivated adversary, which is why security is layered: identity, encryption, tunneling, and marking together.

## Segment 7 — Wrap-Up

Today we covered the security toolkit for multimedia: physical and behavioral biometrics for identity, symmetric and asymmetric encryption for confidentiality, VPNs and IPsec for safe transport, and watermarking for ownership and integrity — plus the attacks that keep designers honest. Next lecture we flip from protecting experiences to measuring them — quality of experience. See you then.
