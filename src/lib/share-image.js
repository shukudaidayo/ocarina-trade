import { WHITELISTED_ERC20, CHAINS } from './constants'
import { formatUnits } from 'ethers'
import { formatTokenAmount } from './wallet'

const WIDTH = 1200
const HEIGHT = 630
const BG = '#1a1a2e'
const SURFACE = '#242442'
const TEXT = '#e0e0e0'
const MUTED = '#888'
const ACCENT = '#6c63ff'
const DIVIDER = '#3a3a5c'

/**
 * Load an image from a URL, returning an Image element.
 * Returns null if it fails (CORS, 404, etc).
 */
function loadImage(url) {
  return new Promise((resolve) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = url
  })
}

/**
 * Truncate an address to 0x1234...abcd format.
 */
function truncate(addr) {
  if (!addr || addr.length < 10) return addr || ''
  return addr.slice(0, 6) + '...' + addr.slice(-4)
}

/**
 * Draw a rounded rectangle.
 */
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

/**
 * Draw an asset tile (image + label) at the given position.
 * Returns the width consumed.
 */
function drawAssetTile(ctx, x, y, img, label, tileSize) {
  const padding = 6
  // Background
  ctx.fillStyle = BG
  roundRect(ctx, x, y, tileSize, tileSize + 28, 8)
  ctx.fill()

  // Image
  if (img) {
    ctx.save()
    roundRect(ctx, x + padding, y + padding, tileSize - padding * 2, tileSize - padding * 2, 6)
    ctx.clip()
    ctx.drawImage(img, x + padding, y + padding, tileSize - padding * 2, tileSize - padding * 2)
    ctx.restore()
  } else {
    ctx.fillStyle = DIVIDER
    roundRect(ctx, x + padding, y + padding, tileSize - padding * 2, tileSize - padding * 2, 6)
    ctx.fill()
    ctx.fillStyle = MUTED
    ctx.font = '20px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('?', x + tileSize / 2, y + tileSize / 2 + 7)
  }

  // Label
  ctx.fillStyle = TEXT
  ctx.font = '14px system-ui, sans-serif'
  ctx.textAlign = 'center'
  const maxLabelWidth = tileSize - 8
  let displayLabel = label
  if (ctx.measureText(label).width > maxLabelWidth) {
    while (displayLabel.length > 3 && ctx.measureText(displayLabel + '...').width > maxLabelWidth) {
      displayLabel = displayLabel.slice(0, -1)
    }
    displayLabel += '...'
  }
  ctx.fillText(displayLabel, x + tileSize / 2, y + tileSize + 20)

  return tileSize
}

/**
 * Resolve the display label for an asset.
 */
function getAssetLabel(asset, chainId) {
  const it = Number(asset.itemType)
  if (it === 0) {
    const sym = CHAINS[chainId]?.nativeSymbol || 'ETH'
    return `${formatTokenAmount(formatUnits(asset.startAmount || asset.amount || '0', 18))} ${sym}`
  }
  if (it === 1) {
    const info = (WHITELISTED_ERC20[chainId] || {})[asset.token]
    return `${formatTokenAmount(formatUnits(asset.startAmount || asset.amount || '0', info?.decimals ?? 18))} ${info?.symbol || '???'}`
  }
  // NFT — name comes from metadata
  return asset._name || `#${asset.identifierOrCriteria || asset.tokenId || '?'}`
}

/**
 * Generate a share image for a completed trade.
 *
 * @param {object} params
 * @param {string} params.maker - Maker address
 * @param {string} params.makerENS - Maker ENS name (or null)
 * @param {string} params.taker - Taker address
 * @param {string} params.takerENS - Taker ENS name (or null)
 * @param {number} params.chainId
 * @param {Array} params.offerItems - Offer items with metadata attached (_name, _image loaded as Image)
 * @param {Array} params.considerationItems - Consideration items with metadata
 * @returns {Promise<Blob>} PNG blob
 */
export async function generateTradeImage({ maker, makerENS, taker, takerENS, chainId, offerItems, considerationItems }) {
  const canvas = document.createElement('canvas')
  canvas.width = WIDTH
  canvas.height = HEIGHT
  const ctx = canvas.getContext('2d')

  // Background
  ctx.fillStyle = BG
  ctx.fillRect(0, 0, WIDTH, HEIGHT)

  // "Deal struck!" heading
  ctx.fillStyle = TEXT
  ctx.font = 'bold 40px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText('Deal struck!', WIDTH / 2, 60)

  // Two sides
  const sideY = 85
  const sideWidth = 520
  const sideHeight = 490
  const leftX = 40
  const rightX = WIDTH - 40 - sideWidth

  // Left side (maker's offer)
  ctx.fillStyle = SURFACE
  roundRect(ctx, leftX, sideY, sideWidth, sideHeight, 12)
  ctx.fill()

  // Right side (taker's consideration)
  ctx.fillStyle = SURFACE
  roundRect(ctx, rightX, sideY, sideWidth, sideHeight, 12)
  ctx.fill()

  // Arrow in the middle
  const arrowX = WIDTH / 2
  const arrowY = sideY + sideHeight / 2
  ctx.fillStyle = ACCENT
  ctx.font = 'bold 36px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText('⇄', arrowX, arrowY + 12)

  // Side headers
  const headerY = sideY + 35
  ctx.font = '16px system-ui, sans-serif'
  ctx.textAlign = 'center'

  ctx.fillStyle = MUTED
  ctx.fillText('From', leftX + sideWidth / 2, headerY - 2)
  ctx.fillStyle = TEXT
  ctx.font = 'bold 18px system-ui, sans-serif'
  const makerLabel = makerENS || truncate(maker)
  ctx.fillText(makerLabel, leftX + sideWidth / 2, headerY + 22)

  ctx.fillStyle = MUTED
  ctx.font = '16px system-ui, sans-serif'
  ctx.fillText('From', rightX + sideWidth / 2, headerY - 2)
  ctx.fillStyle = TEXT
  ctx.font = 'bold 18px system-ui, sans-serif'
  const takerLabel = takerENS || truncate(taker)
  ctx.fillText(takerLabel, rightX + sideWidth / 2, headerY + 22)

  // Dividers
  ctx.strokeStyle = DIVIDER
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(leftX + 20, headerY + 38)
  ctx.lineTo(leftX + sideWidth - 20, headerY + 38)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(rightX + 20, headerY + 38)
  ctx.lineTo(rightX + sideWidth - 20, headerY + 38)
  ctx.stroke()

  // Draw assets
  const tileGap = 12
  const assetsY = headerY + 56
  const availableHeight = sideY + sideHeight - assetsY - 20 // space below header to bottom of box

  async function drawSideAssets(items, sideX, sW) {
    // Scale tile size based on item count — fill the box for 1-2 items
    let tileSize
    const labelHeight = 28
    if (items.length <= 2) {
      // Fit to available height (single row)
      tileSize = Math.min(availableHeight - labelHeight - 20, sW / 2 - 40, 240)
    } else {
      tileSize = 100
    }

    const maxPerRow = Math.max(1, Math.floor((sW - 40) / (tileSize + tileGap)))
    const rows = []
    for (let i = 0; i < items.length; i += maxPerRow) {
      rows.push(items.slice(i, i + maxPerRow))
    }

    // Vertically center rows in available space
    const rowHeight = tileSize + labelHeight + tileGap
    const totalRowsHeight = rows.length * rowHeight - tileGap
    let rowY = assetsY + Math.max(0, (availableHeight - totalRowsHeight) / 2)

    for (const row of rows) {
      const totalWidth = row.length * tileSize + (row.length - 1) * tileGap
      let tileX = sideX + (sW - totalWidth) / 2
      for (const item of row) {
        const label = getAssetLabel(item, chainId)
        drawAssetTile(ctx, tileX, rowY, item._loadedImage || null, label, tileSize)
        tileX += tileSize + tileGap
      }
      rowY += rowHeight
    }
  }

  await drawSideAssets(offerItems, leftX, sideWidth)
  await drawSideAssets(considerationItems, rightX, sideWidth)

  // Footer — logo + ocarina.trade
  const logo = await loadImage('/ot-logo.png')
  const logoSize = 36
  const footerText = 'ocarina.trade'
  ctx.font = 'bold 22px system-ui, sans-serif'
  const textWidth = ctx.measureText(footerText).width
  const totalFooterWidth = logoSize + 8 + textWidth
  const footerX = (WIDTH - totalFooterWidth) / 2
  const footerY = HEIGHT - 22
  if (logo) {
    ctx.drawImage(logo, footerX, footerY - logoSize + 8, logoSize, logoSize)
  }
  ctx.fillStyle = TEXT
  ctx.textAlign = 'left'
  ctx.fillText(footerText, footerX + logoSize + 8, footerY)

  return new Promise((resolve) => {
    canvas.toBlob(resolve, 'image/png')
  })
}

/**
 * Pre-load images for assets so they can be drawn on canvas.
 * Mutates items in place, adding _loadedImage.
 */
export async function preloadAssetImages(items, chainId) {
  const TOKEN_LOGO_URLS = {
    ETH: new URL('../assets/tokens/eth.png', import.meta.url).href,
    POL: new URL('../assets/tokens/pol.png', import.meta.url).href,
    WETH: new URL('../assets/tokens/weth.png', import.meta.url).href,
    USDC: new URL('../assets/tokens/usdc.png', import.meta.url).href,
    USDT: new URL('../assets/tokens/usdt.png', import.meta.url).href,
    USDT0: new URL('../assets/tokens/usdt.png', import.meta.url).href,
    USDS: new URL('../assets/tokens/usds.png', import.meta.url).href,
    EURC: new URL('../assets/tokens/eurc.png', import.meta.url).href,
  }

  await Promise.all(items.map(async (item) => {
    const it = Number(item.itemType)
    if (it === 0) {
      const sym = CHAINS[chainId]?.nativeSymbol || 'ETH'
      item._loadedImage = await loadImage(TOKEN_LOGO_URLS[sym])
    } else if (it === 1) {
      const info = (WHITELISTED_ERC20[chainId] || {})[item.token]
      if (info?.symbol && TOKEN_LOGO_URLS[info.symbol]) {
        item._loadedImage = await loadImage(TOKEN_LOGO_URLS[info.symbol])
      }
    } else if (item._image) {
      item._loadedImage = await loadImage(item._image)
    }
  }))
}
