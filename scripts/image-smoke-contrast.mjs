// Computed browser colors are sRGB. Composite transparent ancestors over white.
const parse = (value) => {
	const numbers = value.match(/[\d.]+/g)?.map(Number);
	if (!/^rgba?\(/.test(value) || !numbers || numbers.length < 3)
		throw new Error(`Unsupported computed color: ${value}`);
	return [...numbers.slice(0, 3), numbers[3] ?? 1];
};
const over = (foreground, background) =>
	foreground.slice(0, 3).map((channel, index) => channel * foreground[3] + background[index] * (1 - foreground[3]));
const luminance = (color) =>
	color
		.map((channel) => {
			const v = channel / 255;
			return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
		})
		.reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
export function computedContrast(textColor, innerToOuterBackgrounds) {
	let background = [255, 255, 255];
	for (const value of [...innerToOuterBackgrounds].reverse()) background = over(parse(value), background);
	const foreground = over(parse(textColor), background);
	const a = luminance(foreground);
	const b = luminance(background);
	return { ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), foreground, background };
}
