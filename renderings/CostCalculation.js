
exports.costCalculation = (scene, type, resolution, samples) => {
    var costIncluded, basePrice, frames
    if (type === 'image') {
        if (resolution <= 50 && samples < 64) return 0
        costIncluded = 0.3
        basePrice = 10.0
        frames = 1
    } else if (type === 'video') {
        if (resolution <= 20 && samples < 16) return 0
        costIncluded = 2.0
        basePrice = 20.0
        frames = scene.frames
    } else {
        console.warn("Unexpect type: ", type)
        return 0
    }
    const sampleFactor = 0.3 * (samples/ 128) + 0.7
    const ratio = resolution / 100
    const pixelsM = ratio * 2.4 * ratio * 1.2
    const pricePerM = 0.02

    // add 50% safety on the machine price
    const machineCost = 1.5 * pixelsM * pricePerM * sampleFactor * frames
    const price = basePrice + Math.max(0.0, machineCost - costIncluded)
    const priceRounded = Math.ceil(price * 10) / 10
    return priceRounded

}
