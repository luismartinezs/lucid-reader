---
title: The Measure of a Line
author: Lucid Reader
reading: sample document
---

# The Measure of a Line

Typographers have argued about line length for five centuries, and the argument
has never really been about beauty. It is about the return sweep: the moment
your eye leaves the end of one line and has to land on the start of the next
one. Make the line too long and the sweep misses, so you read the same line
twice. Make it too short and the sweep happens so often that the rhythm of the
sentence never gets a chance to establish itself.

## What the research settles, and what it does not

The number most often quoted is 66 characters per line, counting spaces. It
comes from Robert Bringhurst, who called it the "widely accepted ideal" and
then, being a careful writer, immediately gave a working range of 45 to 75.
Studies on screens tend to land in the same neighbourhood, though they disagree
about whether the wider end costs you comprehension or only speed.

> A page of prose is not a container for words. It is a set of instructions to
> the eye about where to go next, and how fast.

What the research does not settle is *your* number. Reading speed, visual
acuity, the font you like, the size of your screen, and how tired you are all
move the ideal a few characters in one direction or the other. This is why the
measure is a setting rather than a constant.

### Three things that move with it

1. **Line height.** A long line needs more space beneath it, because the return
   sweep has further to travel and needs a bigger target.
2. **Font size.** Measure is counted in characters, not pixels, so a larger
   font at the same measure gives you a wider column.
3. **Paragraph spacing.** Once the column is wide, the eye needs a stronger
   signal that a paragraph has ended.

## Setting it yourself

Press `[` and `]` in the reader to narrow and widen the column, one character
at a time. The reader writes the value straight into your settings, so the
column you tuned on one document is the column you get on the next one.

```json
{
  "lucid.typography.measure": 68,
  "lucid.typography.fontSize": 19,
  "lucid.typography.lineHeight": 1.7
}
```

Start at 68 and move in steps of four. When you stop noticing the line breaks,
you have found your number.
