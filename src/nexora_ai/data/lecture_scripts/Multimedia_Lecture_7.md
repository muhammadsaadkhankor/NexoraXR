# Lecture 7 — Multimedia Computing: Quality of Experience

**Course:** Multimedia Computing
**Professor narration script** — each block is one spoken segment (maps 1:1 to slides).

---

## Segment 1 — Welcome Back

Welcome back. In our previous lecture we secured multimedia systems — identity, encryption, tunnels, and watermarks. Today we measure something subtler: not whether a system is safe, but whether it is good. In Lecture 7, our focus is quality of experience — how users actually perceive a multimedia service, and how engineers can measure and model that perception. As we go, keep our compression discussion in mind — quality of experience is exactly where all those size-versus-quality trade-offs land. Let's begin.

## Segment 2 — What Is Quality, Anyway?

Quality sounds simple but is remarkably slippery. Philosophically, a quality is just an attribute of a thing — yet defining and measuring it is hard. Engineers split measurement into two kinds. Objective qualities are measurable and verifiable — numbers like weight, thickness, brightness. Subjective qualities can be observed and estimated but never fully measured — beauty, feel, flavor, taste. Multimedia quality lives mostly in the subjective column — and that is what makes this lecture interesting.

## Segment 3 — Quality of Service: The Engineer's View

For years, networks measured quality of service — objective metrics like bandwidth, latency, jitter, and packet loss. QoS answers: did the network deliver the bits well? It is essential — but it is not enough. A video stream can have perfect QoS statistics and still feel terrible: bad content framing, audio lag, a low-bitrate encode. Users do not experience packet loss; they experience a frozen frame at the exciting moment. That gap between delivered quality and perceived quality is why QoE exists.

## Segment 4 — Quality of Experience Defined

Quality of experience is the user's perceived value of a service — the degree of delight or annoyance they feel while using it. It combines objective factors — resolution, bitrate, startup delay — with human factors — expectations, context, mood, even what device they hold. Two viewers on identical networks can rate the same stream differently. QoE therefore asks a fundamentally human question: not "did the system work?" but "was it good for the person using it?"

## Segment 5 — Measuring QoE

How do we measure perception? Two broad approaches. Subjective methods ask humans directly — controlled lab studies where viewers rate content on standardized scales, producing mean opinion scores; expensive but the ground truth. Objective methods predict QoE automatically — models that estimate perceived quality from measurable signals like bitrate, frame freezes, or packet loss, calibrated against human ratings. In practice, objective models are trained and validated on subjective data — the machine learns to imitate the human judge.

## Segment 6 — Modeling QoE

The goal of modeling is a formula or predictor: given technical parameters, estimate the experience a user will report. Simple models map one impairment — say, buffering ratio — to predicted satisfaction. Richer models combine network metrics, content type, device, and viewing context, often learned with machine learning from large subjective datasets. These models let operators tune codecs, bitrates, and infrastructure before users complain — turning QoE from a complaint metric into a design tool. This is also where AI meets multimedia directly.

## Segment 7 — Wrap-Up

Today we separated quality from quality-of-service, defined QoE as the user's perceived value of a service, saw how subjective studies and objective models measure it, and how learned models predict it. Next is our final lecture — the piece that has been underneath everything: artificial intelligence in multimedia. See you then.
