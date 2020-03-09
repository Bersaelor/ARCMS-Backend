import makerjs, { IModelMap, IPathMap } from 'makerjs';
import xml2js from 'xml2js';

const tol = 0.01
const minPadX = 0.2
let m = makerjs.model
let p = makerjs.point

const partNames: {[part: string]: string[]} = {
    bridge: ["bridge", "bruecke", "brücke"],
    shape: ["shape", "front", "frame", "shape_left", "shape_right"],
    hinge: ["hinge", "hinge_left", "hinge_right", "backe"],
    pad: ["pad", "pad_left", "pad_right"]
}

var rgbToHex = function (rgb: number) {
    var hex = Number(rgb).toString(16);
    if (hex.length < 2) {
        hex = "0" + hex;
    }
    return hex;
};

function rgbToColorAttribute(rgb: Array<number>) {
    if (rgb[0] === 255 && rgb[1] === 255 && rgb[2] === 255) {
        return '#000000)';
    } else {
        return `#${rgbToHex(rgb[0])}${rgbToHex(rgb[1])}${rgbToHex(rgb[2])}`;
    }
}

interface SVGPath {
    $: {
        style: string,
        d: string
    }
}

interface SVGCircle {
    $: {
        cx: string,
        cy: string,
        r: string,
        style: string,
    }
}

interface SVGGroup {
    $: {stroke: string} | undefined
    g: SVGGroup[] | undefined
    path: SVGPath[] | undefined
    circle?: SVGCircle[]
}

interface SVG {
    svg: {
        g: SVGGroup[]
    }
}

interface SizeParameters {
    bridgeSize: number
    glasWidth: number
    glasHeight: number
    templeLength: number
}

type LineInfo = {
    line: makerjs.IPathLine,
    route: string[]
    isAtOrigin?: boolean
}

type ArcInfo = {
    arc: makerjs.IPathArc,
    route: string[]
    isAt0?: boolean
}

// helper functions
function origin(line: LineInfo) { return line.isAtOrigin ? line.line.origin : line.line.end }
function end(line: LineInfo) { return line.isAtOrigin ? line.line.end : line.line.origin }
function top(line: makerjs.IPathLine) { return line.origin[1] > line.end[1] ? line.origin : line.end }
function bottom(line: makerjs.IPathLine) { return line.origin[1] > line.end[1] ? line.end : line.origin }
function center(line: makerjs.IPathLine) { return p.scale(p.add(line.origin, line.end), 0.5) }
function sameDirection(vecA: makerjs.IPoint, vecB: makerjs.IPoint) {
    let lowTol = 0.0001
    if (vecA[1] < lowTol || vecB[1] < lowTol) return (vecA[1] < lowTol && vecB[1] < lowTol) && (Math.sign(vecA[0]) === Math.sign(vecB[0]))

    return vecA[0]/vecA[1] - vecB[0]/vecB[1] < lowTol
}
function normSquared(vec: makerjs.IPoint) { return vec[0] * vec[0] + vec[1] * vec[1] }


function modelFromPaths(paths: string[]): makerjs.IModel {
    let makerobjects = paths.map(pathData => {
        const pathModel = makerjs.importer.fromSVGPathData(pathData)
        // when the dxf is converted to the original svg it's y is inverted, undo this here
        const mirroredModel = m.mirror(pathModel, false, true)

        m.originate(mirroredModel)
        m.simplify(mirroredModel)
        return mirroredModel
    })
    let obj = makerobjects.reduce<IModelMap>((acc, cur, i) => {
        acc[i] = cur;
        return acc;
    }, {});
    let model = { models: obj }

    return model
}

function modelFromCircles(circles: SVGCircle[]): makerjs.IModel {
    let circlePaths = circles.map(circle => {
        let radius = parseFloat(circle.$.r)
        // when the dxf is converted to the original svg it's y is inverted, undo this here
        let center = [parseFloat(circle.$.cx), parseFloat(circle.$.cy)]
        return new makerjs.paths.Circle(center, radius)
    })
    let pathMap = circlePaths.reduce<IPathMap>((acc, cur, i) => {
        acc[i] = cur;
        return acc;
    }, {});

    return { paths: pathMap }
}

function createParts(
    part2ColorMap: { [part: string]: string },
    svgObj: SVG | undefined,
): makerjs.IModelMap {

    if (!svgObj || !svgObj.svg || svgObj.svg.g.length < 1 || !svgObj.svg.g[0]) {
        console.log("SvgObj is missing key svg properties!")
        return {}
    }
    let firstGroup = svgObj.svg.g[0]

    var parts: { [part: string]: makerjs.IModel } = {}
    Object.keys(partNames).forEach(part => {
        let color = part2ColorMap[part]
        if (color) {
            let paths = firstGroup.path

            const addMatching = (paths: SVGPath[]) => {
                if (paths.length > 0) parts[part] = modelFromPaths(paths.map(path => path.$.d))
            }

            if (paths) {
                // the qcad converted svg from the cloud always has the all the paths in the array svgObj.svg.g[0].path
                let matchingPaths = paths.filter(path => path.$ && path.$.style.startsWith && path.$.style.startsWith(`stroke:${color}`))
                addMatching(matchingPaths)
                if (firstGroup.circle && firstGroup.circle.length > 0) {
                    let colorFittingCircles = firstGroup.circle.filter(c => c.$.style.startsWith(`stroke:${color}`))
                    if (part === "shape" || part === "hinge") {
                        parts[`${part}_holes`] = modelFromCircles(colorFittingCircles)
                    } else {
                        console.log(`Unhandled circles for ${part}: `, firstGroup.circle)
                    }
                }
            } else if (firstGroup.g) {
                // the dxf-library browser converted previewSVG has a groups array in svgObj.svg.g[0].g each with one path
                firstGroup.g.forEach(group => {
                    if (group.$ && group.$.stroke) {
                        const rgbString = group.$.stroke.startsWith && group.$.stroke.startsWith('rgb(') && group.$.stroke.slice(4)
                        const hex = rgbString && rgbToColorAttribute(rgbString.split(",").map(v => parseInt(v)))
                        if (group.path && hex === color) addMatching(group.path)    
                    }
                })
            }
        }
    })

    return parts
}

type Warning = {
    term: string
    severity: "error" | "warning" | "info"
    data: {[key: string]: string}
}

export async function makeModelParts(
    part2ColorMap: { [part: string]: string },
    svgContents: string
): Promise<makerjs.IModelMap> {
    const parser = new xml2js.Parser();
    const svgObj = await parser.parseStringPromise(svgContents)
    const parts = createParts(part2ColorMap, svgObj)

    const options: makerjs.IFindChainsOptions = {
        pointMatchingDistance: 0.05,
        shallow: false,
        unifyBeziers: true
    }

    var convertedParts: { [part: string]: makerjs.IModel } = {}
    Object.keys(parts).forEach(key => {
        const part = parts[key]
        const chains = m.findChains(part, options) as makerjs.IChain[]
        if (chains && chains.length === 1) {
            let model = makerjs.chain.toNewModel(chains[0], true)
            convertedParts[key] = model
        } else if (chains && chains.length > 1) {
            var modelMap: { [part: string]: makerjs.IModel } = {}
            chains.forEach((element, index) => {
                modelMap[`${key}-${index}`] = makerjs.chain.toNewModel(element, true)
            })
            convertedParts[key] = { models: modelMap }
        }
    })


    if (!convertedParts.bridge || !convertedParts.shape) {
        console.error("ERROR: Glasses parts need to have at least a bridge and a shape!")
        return {}
    }

    let bridgeMeas = makerjs.measure.modelExtents(convertedParts.bridge)
    let shapeMeas = makerjs.measure.modelExtents(convertedParts.shape)
    let isLeftSide = shapeMeas.center[0] < bridgeMeas.center[0]
    
    // move combined model to have origin [0, 0]
    let fullMeas = makerjs.measure.modelExtents({ models: convertedParts })
    let combined = { models: convertedParts, origin: p.scale(fullMeas.low, -1) }
    m.originate(combined)
    m.zero(combined)

    if (isLeftSide) {
        // mirror the parts so the bridge is the part that starts at 0
        Object.keys(combined.models).forEach(key => {
            const model = combined.models[key]
            combined.models[key] = m.distort(model, -1, 1)
        })
        m.zero(combined)
        m.originate(combined)    
    } 

    // move down so the vertical center line is 0
    let newBridgeMeas = makerjs.measure.modelExtents(combined.models.bridge)
    m.moveRelative(combined, [0, -newBridgeMeas.center[1]])
    m.originate(combined)    

    return combined.models
}

function cleanupViaChains(model: makerjs.IModel): makerjs.IModel {
    const options: makerjs.IFindChainsOptions = {
        pointMatchingDistance: 0.01,
        shallow: false,
        unifyBeziers: false
    }

    const chains = m.findChains(model, options) as makerjs.IChain[]

    var chainedParts: makerjs.IModelMap  = {}
    chains.forEach((element, index) => {
        // paths smaller then 1mm are artefacts that need to be removed
        if (element.pathLength < 1 || element.links.length < 3) return
        chainedParts[`chain_${index}`] = makerjs.chain.toNewModel(element, true)
    })

    return { models: chainedParts }
}

function lineDistance(lineA: makerjs.IPathLine, lineB: makerjs.IPathLine): number {
    let distSameDirection = makerjs.measure.pointDistance(lineA.origin, lineB.origin) + makerjs.measure.pointDistance(lineA.end, lineB.end)
    let distOppositeDirection = makerjs.measure.pointDistance(lineA.origin, lineB.end) + makerjs.measure.pointDistance(lineA.end, lineB.origin)
    return Math.min(distSameDirection, distOppositeDirection)
} 

type LineToDivideInfo = {
    lineToDivide: LineInfo,
    otherLine: LineInfo,
    middlePoint: makerjs.IPoint,
    modelAorB: 'a' | 'b'
}

function checkLines(
    lineA: makerjs.IPathLine,
    lineB: makerjs.IPathLine,
    routeA: string[],
    routeB: string[],
    commonLines: [LineInfo, LineInfo][],
    linesToSubdivide: LineToDivideInfo[]
) {
    let dAoBo = makerjs.measure.pointDistance(lineA.origin, lineB.origin)
    let dAeBe = makerjs.measure.pointDistance(lineA.end, lineB.end)
    let dAoBe = makerjs.measure.pointDistance(lineA.origin, lineB.end)
    let dAeBo = makerjs.measure.pointDistance(lineA.end, lineB.origin)

    // early exit if no points are close
    if (!(dAeBe < tol || dAeBe < tol || dAoBe < tol || dAeBo < tol)) return

    let distSameDirection = dAoBo + dAeBe
    let distOppositeDirection = dAoBe + dAeBo

    // when both lines are equal, we add them to the common lines
    if (Math.min(distSameDirection, distOppositeDirection) < tol) {
        commonLines.push([ { line: lineA, route: routeA }, { line: lineB, route: routeB } ])
        return
    }

    // lines aren't exactly equal but might be colinear
    let isAtOriginA = dAoBo < tol || dAoBe < tol
    let commonPA = isAtOriginA ? lineA.origin : lineA.end
    let otherPA = isAtOriginA ? lineA.end : lineA.origin
    let isAtOriginB = dAoBo < tol || dAeBo < tol
    let commonPB = isAtOriginB ? lineB.origin : lineB.end
    let otherPB = isAtOriginB ? lineB.end : lineB.origin
    let vA = p.subtract(otherPA, commonPA)
    let vB = p.subtract(otherPB, commonPB)
    if (!sameDirection(vA, vB)) return

    // lines start in the same point and are pointing in the same direction, the longer vec should be subdivided
    let subdivideModelAorB: 'a' | 'b' = normSquared(vA) > normSquared(vB) ? 'a' : 'b'
    p.subtract(commonPA, lineA.origin)
    let lineToDivide: LineInfo = subdivideModelAorB === 'a' ? {line: lineA, route: routeA, isAtOrigin: isAtOriginA} : {line: lineB, route: routeB, isAtOrigin: isAtOriginB}
    linesToSubdivide.push({
        lineToDivide: lineToDivide,
        otherLine: subdivideModelAorB === 'a' ? {line: lineB, route: routeB} : {line: lineA, route: routeA},
        middlePoint: p.add(commonPA, subdivideModelAorB ? vB : vA),
        modelAorB: subdivideModelAorB
    })
}

function findConnections(modelA: makerjs.IModel, modelB: makerjs.IModel) {
    // find the line line that connects the two models
    var commonLines: [LineInfo, LineInfo][] = []
    // check whether colinear lines exist that need a subdivision
    var linesToSubdivide: LineToDivideInfo[] = []
    let walkThroughA: makerjs.IWalkOptions = {
        onPath: (wpA) => {
            if (makerjs.isPathLine(wpA.pathContext)) {
                let lineInA = wpA.pathContext as makerjs.IPathLine
                let walkThroughB: makerjs.IWalkOptions = {
                    onPath: (wpB) => {
                        if (makerjs.isPathLine(wpB.pathContext)) {
                            let lineInB = wpB.pathContext as makerjs.IPathLine
                            checkLines(lineInA, lineInB, wpA.route, wpB.route, commonLines, linesToSubdivide)
                        }
                    }
                }
                m.walk(modelB, walkThroughB)
            } else if (makerjs.isPathArc(wpA.pathContext)) {
                // TODO: insert treatment when models meet in an arc
            } else {
                console.log("Unexpected path in shape: ", wpA.pathContext)
            }
        }
    }
    m.walk(modelA, walkThroughA)

    linesToSubdivide.forEach(info => {
        let partToModify = info.modelAorB === 'a' ? modelA : modelB
        var addedLine: makerjs.IPathLine
        if (info.lineToDivide.isAtOrigin) {
            addedLine = new makerjs.paths.Line(p.clone(info.middlePoint), p.clone(info.lineToDivide.line.end))
            info.lineToDivide.line.end = p.clone(info.middlePoint)            
        } else {
            addedLine = new makerjs.paths.Line(p.clone(info.lineToDivide.line.origin), p.clone(info.middlePoint))
            info.lineToDivide.line.origin = p.clone(info.middlePoint)            
        }
        if (info.lineToDivide.route.length > 1 && info.lineToDivide.route[0] === 'paths' && partToModify.paths) {
            partToModify.paths[`${info.lineToDivide.route[1]}_add`] = addedLine
        } else {
            console.error("Expected the subdivided line to have a route that starts with 'paths', found: ", info.lineToDivide.route)
        }

        commonLines.push([info.lineToDivide, info.otherLine])
    })

    return commonLines
}

function findPreviousAndNextLine(model: makerjs.IModel, line: makerjs.IPathLine) {
    var linesToTop: (LineInfo | ArcInfo)[] = []
    var linesToBottom: (LineInfo | ArcInfo)[] = []
    let topPoint = line.origin[1] > line.end[1] ? line.origin : line.end
    let bottomPoint = line.origin[1] > line.end[1] ? line.end : line.origin

    var walkOptions: makerjs.IWalkOptions = {
        onPath: function (wp) {
            if (makerjs.isPathLine(wp.pathContext)) {
                let line = wp.pathContext as makerjs.IPathLine
                let originToTop = makerjs.measure.pointDistance(topPoint, line.origin)
                let endTopTop = makerjs.measure.pointDistance(topPoint, line.end)
                let distToTop = Math.min( originToTop, endTopTop)
                let originToBottom = makerjs.measure.pointDistance(bottomPoint, line.origin)
                let endToBottom = makerjs.measure.pointDistance(bottomPoint, line.end)
                let distToBottom = Math.min(originToBottom, endToBottom)
                if (distToTop < tol) linesToTop.push({
                    line: line, route: wp.route, isAtOrigin: originToTop < endTopTop
                })
                if (distToBottom < tol) linesToBottom.push({
                    line: line, route: wp.route, isAtOrigin: originToBottom < endToBottom
                })
            } else if (makerjs.isPathArc(wp.pathContext)) {
                let arc = wp.pathContext as makerjs.IPathArc
                let endpoints = p.fromArc(arc)
                let startToTop = makerjs.measure.pointDistance(topPoint, endpoints[0])
                let endTopTop = makerjs.measure.pointDistance(topPoint, endpoints[1])
                let distToTop = Math.min(startToTop, endTopTop)
                let startToBottom = makerjs.measure.pointDistance(bottomPoint, endpoints[0])
                let endToBottom = makerjs.measure.pointDistance(bottomPoint, endpoints[1])
                let distToBottom = Math.min(startToBottom, endToBottom)
                if (distToTop < tol) linesToTop.push({
                    arc: arc, route: wp.route, isAt0: startToTop < endTopTop
                })
                if (distToBottom < tol) linesToBottom.push({
                    arc: arc, route: wp.route, isAt0: startToBottom < endToBottom
                })
            }
        }
    }
    m.walk(model, walkOptions)

    return { pathsToTop: linesToTop, pathsToBottom: linesToBottom }
}

function justLines(paths: (LineInfo | ArcInfo)[]): LineInfo[] {
    let lines = paths.filter(path => (path as LineInfo).line) as LineInfo[]
    return lines
}

function findLineNotequal(lines: LineInfo[], line: makerjs.IPathLine) {
    return lines.find(lineInfo => lineDistance(lineInfo.line, line) > tol)
} 

function clone(model: makerjs.IModel) {
    return makerjs.cloneObject(model)
}

function lineInModel(model: makerjs.IModel, lineInfo: LineInfo): makerjs.IPathLine | undefined {
    var runner = model as any
    lineInfo.route.forEach( routeKey => runner = runner[routeKey] as any)
    if (makerjs.isPathLine(runner)) {
        let line = runner as makerjs.IPathLine
        return line
    }
    return undefined
}

function arcInModel(model: makerjs.IModel, lineInfo: ArcInfo): makerjs.IPathArc | undefined {
    var runner = model as any
    lineInfo.route.forEach( routeKey => runner = runner[routeKey] as any)
    if (makerjs.isPathArc(runner)) {
        let arc = runner as makerjs.IPathArc
        return arc
    }
    return undefined
}

function setArcInModel(route: any[], model: makerjs.IModel, arc:  makerjs.IPathArc) {
    var runner = model as any
    let lastKey = route.pop() as any
    route.forEach( routeKey => runner = runner[routeKey] as any)
    if (lastKey !== undefined) {
        runner[lastKey] = arc
    } else {
        console.log("Failed to set arc for route: ", route)
    }
}

function setPointEqual(lineInfo: LineInfo, model: makerjs.IModel, goalPoint: makerjs.IPoint) {
    let line = lineInModel(model, lineInfo)
    if (!line) return
    if (lineInfo.isAtOrigin) line.origin = p.clone(goalPoint)
    else line.end = p.clone(goalPoint)
}

function highestLine(connections: [LineInfo, LineInfo][]): [LineInfo, LineInfo] | undefined {
    var currentTop = Number.NEGATIVE_INFINITY
    var line: [LineInfo, LineInfo] | undefined 

    connections.forEach(linePair => {
        if (top(linePair[0].line)[1] > currentTop) {
            currentTop = top(linePair[0].line)[1]
            line = linePair
        }
    })

    return line
}

/**  
 * Moves and adjusts the geometries of the provided shapes, so that their common lines
 * overlap exactly
 *
 * @param shapes the two shapes to be connected
 * @param connections the common lines between 1 and 2, supposed to be non-empty
 */
function reconnectShapes(
    shapes: [makerjs.IModel, makerjs.IModel], 
    connections: [LineInfo, LineInfo][],
    move: 0 | 1,
    modify: 0 | 1
) {
    if (connections.length < 1) throw Error("The connections between shapes should be non empty!")
    let unmoved = move === 1 ? 0 : 1
    m.originate({models: {shape: shapes[0], hinge: shapes[1]}})
    let topLine = highestLine(connections) as [LineInfo, LineInfo]
    let topActualPoint = top(lineInModel(shapes[move], topLine[move]) as makerjs.IPathLine)
    let topGoalPoint = top(lineInModel(shapes[unmoved], topLine[unmoved]) as makerjs.IPathLine)
    let translation = p.subtract(topGoalPoint, topActualPoint)
    m.moveRelative(shapes[move], translation)

    // the bottom point gets adjusted so it fits again
    m.originate({models: {shape: shapes[0], hinge: shapes[1]}})
    let unmodified = modify === 1 ? 0 : 1
    let bottomGoalPoint = bottom(lineInModel(shapes[unmodified], topLine[unmodified]) as makerjs.IPathLine)
    let { pathsToBottom } = findPreviousAndNextLine(shapes[modify], lineInModel(shapes[modify], topLine[modify])!)
    if (pathsToBottom.length !== 2) {
        console.error("Expected 2 lines to connect to a point in an endless curve, found ", pathsToBottom.length)
        return
    }
    setConnectingLinesToGoal(pathsToBottom, shapes[modify], bottomGoalPoint)
 
    // adjust all other lines and points to equal 
    connections.forEach(connection => {
        if (lineDistance(connection[0].line, topLine[0].line) < tol) return
        // Adjusting the lines which are not the top to be equal
        let goalLine = lineInModel(shapes[unmodified], connection[unmodified])!
        let { pathsToTop, pathsToBottom } = findPreviousAndNextLine(shapes[modify], lineInModel(shapes[modify], connection[modify])!)
        setConnectingLinesToGoal(pathsToTop, shapes[modify], top(goalLine))
        setConnectingLinesToGoal(pathsToBottom, shapes[modify], bottom(goalLine))
    });
}

function setConnectingLinesToGoal(connectingPaths: (LineInfo | ArcInfo)[], modifiedShape: makerjs.IModel, goalPoint:  makerjs.IPoint) {
    connectingPaths.forEach(pathInfo => {
        if ((pathInfo as LineInfo).line) {
            let lineInfo = pathInfo as LineInfo
            setPointEqual(lineInfo, modifiedShape, goalPoint)    
        } else if ((pathInfo as ArcInfo).arc) {
            let arcInfo = pathInfo as ArcInfo
            let currentArc = arcInModel(modifiedShape, arcInfo)!
            let keepPoint = arcInfo.isAt0 ? p.fromArc(currentArc)[1] : p.fromArc(currentArc)[0]
            let newArc = new makerjs.paths.Arc(keepPoint, goalPoint, arcInfo.arc.radius, false, true)
            setArcInModel(arcInfo.route, modifiedShape, newArc)
        }
    })
}

/**  
 * Combines the provided parts into a full glasses frame, given the provided sizes
 *
 * @param parts the two modeljs parts to be combined
 * @param sizes the chosen size parameters
 * @param defaultSizes the default size parameters
 * @param partial the partial step for debugging purposes
 */
export function combineModel(
    parts: makerjs.IModelMap,
    bridgeSize: number,
    glasWidth: number,
    glasHeight: number,
    defaultSizes: SizeParameters,
    step?: 'scaled_parts' | 'chained_parts' | 'bridge&Shape' | 'bridge&Shape&Hinge' | 'fullside' | 'final'
): { model: makerjs.IModel, warnings: Warning[] } {
    var warnings: Warning[] = []

    if (!parts.shape || !parts.pad || !parts.bridge) {
        console.error("ERROR: So far only glasses that have a shape, bridge and pad can be combined!")
        warnings.push({ term: "frameupload.dxfwarning.partsMissing", data: {}, severity: "error" })
        return { model: { }, warnings: warnings }
    }
    
    // TODO: if the `distort` function makes a copy anyway, try doing the distort first, without extra cloning
    let shape = clone(parts.shape)
    let pad = clone(parts.pad)
    let hinge = parts.hinge && clone(parts.hinge)
    let originalHingeMeas = hinge && makerjs.measure.modelExtents(hinge)
    var bridge = clone(parts.bridge)

    // check connections and post warnings
    let shapePadConnections = findConnections(shape, pad)
    if (shapePadConnections.length < 1) {
        console.log("ERROR: Expected a single line in the Shape part that connects to the Pad, found ", shapePadConnections.length)
    }
    let shapeHingeConnections = hinge && findConnections(shape, hinge)
    if (hinge && shapeHingeConnections.length < 1) {
        console.log("ERROR: Expected some lines that connect/overlap between Shape and Hinge!")
        warnings.push({ term: "frameupload.dxfwarning.noLineConnects1And2", data: { PART1: "shape", PART2: "hinge" }, severity: "error" })
    }
    let bridgeShapeConnections = findConnections(bridge, shape)
    if (bridgeShapeConnections.length < 1) {
        console.log("ERROR: Expected some lines that connect/overlap between Bridge and shape!")
        warnings.push({ term: "frameupload.dxfwarning.noLineConnects1And2", data: { PART1: "bridge", PART2: "shape" }, severity: "error" })
    }

    let bridgeMeas = makerjs.measure.modelExtents(bridge)
    let shapeMeas = makerjs.measure.modelExtents(shape)
    let padMeas = makerjs.measure.modelExtents(pad)
    let padMin = padMeas.low[0]

    let bridgeFactor = 1 - (defaultSizes.bridgeSize - bridgeSize)/(2 * bridgeMeas.width)
    let bridgeXTranslation = (bridgeSize - defaultSizes.bridgeSize)/2
    let verticalFactor = glasHeight / defaultSizes.glasHeight
    let horizontalFactor = glasWidth / defaultSizes.glasWidth
    // next line is needed to fix issue with 62-18-37
    let floatingPointIncreaser = 1.00001
    // scale bridge around center
    bridge = m.distort(bridge, bridgeFactor * floatingPointIncreaser, verticalFactor * floatingPointIncreaser)

    // scale shape
    m.moveRelative(shape, [-shapeMeas.low[0], 0])
    m.originate(shape)
    shape = m.distort(shape, horizontalFactor, verticalFactor, false, 0.5)
    m.moveRelative(shape, [shapeMeas.low[0], 0])
    // translate shape because bridge moved it's left start
    m.moveRelative(shape, [bridgeXTranslation, 0])

    if (bridgeShapeConnections.length > 0) {
        reconnectShapes([bridge, shape], bridgeShapeConnections, 1, 0)
    }

    if (step === 'scaled_parts') return { model: { models: { bridge: bridge, shape: shape, pad: pad, hinge: hinge }}, warnings: warnings }

    // move the hinge so it connects properly to the shape
    if (hinge && shapeHingeConnections.length > 0) {
        // Seems pointless, but the next line is so far needed otherwise atlas at 60-18-37 doesn't work
        hinge = m.distort(hinge, 1, 1)
        reconnectShapes([shape, hinge], shapeHingeConnections, 1, 0)
    }

    // move the pad
    let lineInShape = shapePadConnections.length > 0 && shapePadConnections[0][0]
    let lineInPad = shapePadConnections.length > 0 && shapePadConnections[0][1]
    let padDelta = [padMeas.high[0] - shapeMeas.low[0], padMeas.high[1]]
    var padTranslation = [padDelta[0] * (horizontalFactor - 1), padDelta[1] * (verticalFactor - 1)]
    if (lineInShape && lineInPad) {
        let shapeLineMiddle = center(lineInModel(shape, lineInShape)!)
        let padLineMiddle = center(lineInModel(pad, lineInPad)!)
        padTranslation[1] = p.subtract(shapeLineMiddle, padLineMiddle)[1]
    }
    var totalPadTranslation = p.add([bridgeXTranslation, 0], padTranslation)
    let padDiff = padMin + totalPadTranslation[0] - minPadX
    if (padDiff < 0) {
        totalPadTranslation[0] = minPadX - padMin
    }
    m.moveRelative(pad, totalPadTranslation)

    // connect the pads to the shape on the connecting line
    m.originate({models: {shape: shape, pad: pad}})
    if (lineInShape && lineInPad) {
        pad = m.distort(pad, 1, 1)
        // connecting the pad to the shape is special as we're trying to keep the angle of attack of the arm the same
        let shapeLine = lineInModel(shape, lineInShape)
        let { pathsToTop, pathsToBottom } = findPreviousAndNextLine(pad, lineInPad.line)
        let linesToTop = justLines(pathsToTop)
        let linesToBottom = justLines(pathsToBottom)
        if (shapeLine) {
            let topPoint = top(shapeLine)
            let bottomPoint = bottom(shapeLine)
            let padLineToTop = findLineNotequal(linesToTop, lineInPad.line)
            if (padLineToTop) {
                let topHorizontalChange = p.subtract(topPoint, origin(padLineToTop))[0]
                if (Math.abs(topHorizontalChange) > tol) {
                    // move the pad up/down so that the angle of the line stays the same
                    let slopeVec = p.subtract(end(padLineToTop), origin(padLineToTop))
                    if (Math.abs(slopeVec[0]) > tol) {
                        let slope = slopeVec[1] / slopeVec[0]
                        let verticalChange = -slope * topHorizontalChange
                        m.moveRelative(pad, [0, verticalChange])
                        m.originate({models: {shape: shape, pad: pad}})
                    }
                }
            } 
            linesToTop.forEach(lineInfo => setPointEqual(lineInfo, pad, topPoint))
            linesToBottom.forEach(lineInfo => setPointEqual(lineInfo, pad, bottomPoint))

        } else {
            warnings.push({ term: "frameupload.dxfwarning.noLineConnects1And2", data: { PART1: "pad", PART2: "shape" }, severity: "error" })
            console.log("ERROR: Found connecting lines in the original, but couldn't find them during the algorithm!")
        }
    } else {
        warnings.push({ term: "frameupload.dxfwarning.noLineConnects1And2", data: { PART1: "pad", PART2: "shape" }, severity: "error" })
        console.log("ERROR: Failed to find line that connects Pad and Shape!")
    }

    if (parts.shape_holes) {
        let holes = clone(parts.shape_holes)

        // scale the hole positions the same way as the shape
        // basically what `holes = m.distort(holes, horizontalFactor, verticalFactor)` would do
        holes.models && Object.keys(holes.models).forEach(key => {
            if (!holes.models) return
            let hole = holes.models[key]
            // we scale the shape from the lower end
            var center = p.subtract(makerjs.measure.modelExtents(hole).center, [shapeMeas.low[0], 0])
            let scaledCenter = [center[0] * horizontalFactor, center[1] * verticalFactor]
            let diff = p.subtract(scaledCenter, center)
            m.moveRelative(hole, diff)
        })    
    
        m.moveRelative(holes, [bridgeXTranslation, 0])
        shape = m.combineSubtraction(shape, holes)
    }


    // holes in the hinge
    if (originalHingeMeas && parts.hinge_holes) {
        let holes = clone(parts.hinge_holes)
        let hingeMeas = makerjs.measure.modelExtents(hinge)
        // get the hinge position change
        let hingeTranslation = p.subtract(hingeMeas.center, originalHingeMeas.center)

        // move the holes accordingly
        holes.models && Object.keys(holes.models).forEach(key => {
            let hole = holes.models![key]
            m.moveRelative(hole, hingeTranslation)
        })

        hinge = m.combineSubtraction(hinge, holes)
    }

    if (shapePadConnections.length < 1) {
        console.log("No commonLines found, not even trying to combine")
        warnings.push({ term: "frameupload.dxfwarning.missingConnection", data: {}, severity: "error" })
        let fullFrame = {models: parts}
        return { model: fullFrame, warnings: warnings }
    }


    // convert the shapes into chains, to filter out artefacts

    pad = cleanupViaChains(pad)
    bridge = cleanupViaChains(bridge)
    shape = cleanupViaChains(shape)

    if (step === 'chained_parts') return { model: { models: { bridge: bridge, shape: shape, pad: pad, hinge: hinge }}, warnings: warnings }

    // combine the shapes into glasses
    // let options = {pointMatchingDistance: 0.005}
 
    let bridgeAndShape = m.combine(bridge, shape, false, true, false, true)
    if (step === 'bridge&Shape') return { model: { models: { bridgeAndShape: bridgeAndShape, pad: pad, hinge: hinge }}, warnings: warnings }
    let bridgeShapeAndHinge = m.combine(bridgeAndShape, hinge, false, true, false, true)
    if (step === 'bridge&Shape&Hinge') return { model: { models: { bridgeShapeAndHinge: bridgeShapeAndHinge, pad: pad }}, warnings: warnings }
    var fullSide = m.combine(bridgeShapeAndHinge, pad, false, true, false, true)

    // mirror the fullside and combine it together into a fullframe
    fullSide = cleanupViaChains(fullSide)
    if (step === 'fullside') return { model: fullSide, warnings: warnings }

    let mirroredSide = m.mirror(fullSide, true, false)
    let mirrorConnections = findConnections(fullSide, mirroredSide)
    if (mirrorConnections.length > 0) reconnectShapes([fullSide, mirroredSide], mirrorConnections, 0, 1)
    mirroredSide = cleanupViaChains(mirroredSide)
    m.moveRelative(mirroredSide, [0.0001, 0])

    let fullFrame = m.combine(fullSide, mirroredSide, false, true, false, true, { trimDeadEnds: false })

    return { model: fullFrame, warnings: warnings }
}
