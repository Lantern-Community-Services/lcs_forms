/**
 * The Profile screen's avatar swatches (frontend/src/screens/Profile.tsx).
 * Every new account starts on one picked at random, so a list of people isn't
 * a column of identical navy circles; they can change it on their Profile.
 */
export const AVATAR_COLORS = ["#1d4ed8", "#7c3aed", "#be123c", "#c2410c", "#a16207", "#15803d", "#0f766e", "#6b4f3b"];

export const randomAvatarColor = () => AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
