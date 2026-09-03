---
name: Overdrive Low-Poly
colors:
  surface: '#131313'
  surface-dim: '#131313'
  surface-bright: '#393939'
  surface-container-lowest: '#0e0e0e'
  surface-container-low: '#1b1c1c'
  surface-container: '#1f2020'
  surface-container-high: '#2a2a2a'
  surface-container-highest: '#353535'
  on-surface: '#e5e2e1'
  on-surface-variant: '#ddc1ae'
  inverse-surface: '#e5e2e1'
  inverse-on-surface: '#303030'
  outline: '#a48c7a'
  outline-variant: '#564334'
  surface-tint: '#ffb77d'
  primary: '#ffb77d'
  on-primary: '#4d2600'
  primary-container: '#ff8c00'
  on-primary-container: '#623200'
  inverse-primary: '#904d00'
  secondary: '#accfb1'
  on-secondary: '#183721'
  secondary-container: '#2e4d36'
  on-secondary-container: '#9bbea0'
  tertiary: '#a7c8ff'
  on-tertiary: '#003060'
  tertiary-container: '#87abe5'
  on-tertiary-container: '#123f72'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#ffdcc3'
  primary-fixed-dim: '#ffb77d'
  on-primary-fixed: '#2f1500'
  on-primary-fixed-variant: '#6e3900'
  secondary-fixed: '#c7eccc'
  secondary-fixed-dim: '#accfb1'
  on-secondary-fixed: '#02210e'
  on-secondary-fixed-variant: '#2e4d36'
  tertiary-fixed: '#d5e3ff'
  tertiary-fixed-dim: '#a7c8ff'
  on-tertiary-fixed: '#001c3b'
  on-tertiary-fixed-variant: '#1e477b'
  background: '#131313'
  on-background: '#e5e2e1'
  surface-variant: '#353535'
typography:
  display-hero:
    fontFamily: Montserrat
    fontSize: 72px
    fontWeight: '900'
    lineHeight: 80px
    letterSpacing: -0.04em
  headline-lg:
    fontFamily: Montserrat
    fontSize: 32px
    fontWeight: '800'
    lineHeight: 40px
  headline-lg-mobile:
    fontFamily: Montserrat
    fontSize: 28px
    fontWeight: '800'
    lineHeight: 34px
  stat-number:
    fontFamily: Montserrat
    fontSize: 48px
    fontWeight: '900'
    lineHeight: 48px
    letterSpacing: -0.02em
  body-md:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '500'
    lineHeight: 24px
  label-caps:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '700'
    lineHeight: 16px
    letterSpacing: 0.1em
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  unit: 8px
  safe-margin: 24px
  gutter: 16px
  hud-padding: 32px
---

## Brand & Style
The design system is built for a premium, high-energy mobile experience that bridges the gap between casual accessibility and cinematic immersion. The personality is adventurous and polished, utilizing a **Modern-Tactile** style. This approach blends clean, minimalist UI surfaces with subtle 3D depth to complement the low-poly game world without competing with it. 

The emotional response should be one of "effortless speed." This is achieved through generous negative space, high-contrast interactive elements, and a "physical" feel to the interface that mirrors the tactile nature of driving.

## Colors
The palette is rooted in a "Forest Highway" theme, using natural tones to provide a sophisticated backdrop for high-intensity action.

- **Primary (Sunset Orange):** Reserved strictly for "Go" actions, progress bars, and critical interactive feedback.
- **Secondary (Forest Green) & Background (Deep Green):** Establishes the core environmental mood; used for deep-layered UI panels and containers.
- **Tertiary (Muted Blue):** Used for secondary stats, navigation icons, and utility functions (e.g., settings, garage).
- **Surface (Warm Beige):** Used as a high-contrast text and icon color against dark backgrounds to ensure premium readability.
- **Neutral (Dark Charcoal):** Applied to the HUD and overlays to provide a grounded, high-contrast frame for the 3D action.

## Typography
Typography is optimized for rapid scanning at high speeds. 

- **Display & Stats:** Use Montserrat with heavy weights (ExtraBold/Black). Numbers for distance and speed should be oversized to feel impactful.
- **UI & Controls:** Inter provides a utilitarian balance, ensuring that descriptions and settings remain legible even on smaller mobile screens.
- **Dynamic Scaling:** For mobile, "Display" styles should occupy the top 20% of the screen during menus, while "Stat-number" scales down 15% when part of the active HUD during gameplay.

## Layout & Spacing
This design system follows a **Portrait Mobile Fixed Grid** (1080x1920 logical units). 

- **The HUD Zone:** Critical information (Speed, Score) is anchored to the top 10% of the screen with a 32px safe-area margin to avoid camera obstruction.
- **Interaction Zone:** Primary controls are anchored to the bottom 25% of the screen, optimized for thumb reach.
- **Modals:** Use a center-anchored layout with a 48px margin from the screen edges to maintain the "cinematic" feel by showing the 3D world in the periphery.

## Elevation & Depth
To match the low-poly 3D aesthetic, elevation is conveyed through **Tonal Layers** and **Restrained Gradients**.

- **Surfaces:** UI panels use a subtle vertical gradient (darker at the bottom) to simulate a physical slab. 
- **Shadows:** Use "Soft Ambient" shadows. Shadows should be tinted with the `Background` color (#1B3022) at 40% opacity rather than pure black, creating a more integrated, premium look.
- **Inner Glow:** Interactive buttons feature a 1px top-edge highlight to simulate light catching the edge of a physical object.

## Shapes
The shape language is "Softened Geometric." While the game world is low-poly and sharp, the UI uses **Rounded (0.5rem - 1.5rem)** corners to provide a "premium casual" feel that is comfortable for touch. This contrast makes the UI feel like a high-tech glass cockpit hovering over a rugged world.

## Components

- **Primary Action Button:** Large, Sunset Orange (#FF8C00) with a 4px bottom "shelf" (darker shade of orange) to create a tactile, pressable look. Text is always Black (#222222) or White for maximum pop.
- **HUD Gauges:** Circular or semi-circular progress bars using Sunset Orange for the fill and a semi-transparent Dark Charcoal for the track.
- **Stat Cards:** Forest Green (#2E4D36) base with Warm Beige text. Features a 1px border of Muted Blue to define the edges against the 3D background.
- **Selection Chips:** Used in the Garage. Active state is Sunset Orange; inactive state is a semi-transparent Dark Charcoal with a White outline.
- **Input/Settings:** Sliders use a thick Muted Blue track with a large, Sunset Orange circular thumb for easy manipulation.
- **Mission List:** Clean rows with 16px vertical spacing. Uses subtle background blurs (Glassmorphism) to keep the 3D environment visible but non-distracting behind text.