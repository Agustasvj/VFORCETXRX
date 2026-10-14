"""
RC Controller — Channel processing engine for VForce RC.

Processes raw input from the phone (sticks, sliders, buttons, switches)
and maps them to 16 RC channels. Applies the standard RC processing chain:

    Input → Expo → Rate → Trim → Mixing → Endpoints → Output

Channel values are normalized to -1.0 … +1.0
Servo equivalent: 1000µs (-1.0) → 1500µs (0.0) → 2000µs (+1.0)
"""


class RCController:
    NUM_CHANNELS = 16

    def __init__(self, models_data):
        self.models_data = models_data
        self.channels = [0.0] * self.NUM_CHANNELS
        self.apply_failsafe()

    def update_models(self, data):
        self.models_data = data

    def apply_failsafe(self):
        """Set channels to configured failsafe values or center."""
        model = self.get_active_model()
        failsafe = model.get("failsafe", {}) if model else {}
        for i in range(self.NUM_CHANNELS):
            k = str(i + 1)
            if k in failsafe:
                self.channels[i] = self._clamp(float(failsafe[k]) / 100.0)
            else:
                self.channels[i] = 0.0

    def get_active_model(self):
        active_id = self.models_data.get("active_model", "")
        return self.models_data.get("models", {}).get(active_id, {})

    # ── Processing helpers ────────────────────────────────────────────

    @staticmethod
    def _apply_expo(value, expo_pct):
        """
        Standard RC exponential curve.
        expo_pct 0 = fully linear, 100 = fully cubic (soft center).
        Formula: out = (1 − e) · x  +  e · x³
        """
        if expo_pct == 0:
            return value
        e = max(0.0, min(100.0, abs(expo_pct))) / 100.0
        return (1.0 - e) * value + e * (value ** 3)

    @staticmethod
    def _apply_rate(value, rate_pct):
        """Scale output by rate percentage.  100 % = full throw."""
        return value * (max(0.0, min(150.0, rate_pct)) / 100.0)

    @staticmethod
    def _clamp(value, lo=-1.0, hi=1.0):
        return max(lo, min(hi, value))

    # ── Main processing ───────────────────────────────────────────────

    def process_input(self, data):
        """
        Process raw phone input into channel values.

        Expected *data* format (sent by the mobile app):
        {
            "axes":     {"el_id": float, …},       # -1.0 … +1.0
            "buttons":  {"el_id": bool,  …},        # true / false
            "switches": {"el_id": float, …}         # -1.0 / 0.0 / +1.0
        }
        """
        model = self.get_active_model()
        if not model:
            return

        channel_map = model.get("channel_map", {})
        trims       = model.get("trims", {})
        rates       = model.get("rates", {})
        expo_cfg    = model.get("expo", {})
        endpoints   = model.get("endpoints", {})

        axes     = data.get("axes", {})
        buttons  = data.get("buttons", {})
        switches = data.get("switches", {})

        # ── 1. Map inputs → raw channel values ───────────────────────
        raw = [0.0] * self.NUM_CHANNELS

        for el_id, value in axes.items():
            mapping = channel_map.get(el_id)
            if not mapping:
                continue
            ch = mapping.get("channel", 0)
            if not (1 <= ch <= self.NUM_CHANNELS):
                continue
            val = float(value)
            if mapping.get("reversed", False):
                val = -val
            raw[ch - 1] = self._clamp(val)

        for el_id, is_pressed in buttons.items():
            mapping = channel_map.get(el_id)
            if not mapping:
                continue
            ch = mapping.get("channel", 0)
            if not (1 <= ch <= self.NUM_CHANNELS):
                continue
            val = 1.0 if is_pressed else -1.0
            if mapping.get("reversed", False):
                val = -val
            raw[ch - 1] = val

        for el_id, value in switches.items():
            mapping = channel_map.get(el_id)
            if not mapping:
                continue
            ch = mapping.get("channel", 0)
            if not (1 <= ch <= self.NUM_CHANNELS):
                continue
            val = float(value)
            if mapping.get("reversed", False):
                val = -val
            raw[ch - 1] = self._clamp(val)

        # ── 2. Per-channel processing: Expo → Rate → Trim ────────────
        for i in range(self.NUM_CHANNELS):
            k   = str(i + 1)
            val = raw[i]

            val = self._apply_expo(val, expo_cfg.get(k, 0))
            val = self._apply_rate(val, rates.get(k, 100))

            trim = trims.get(k, 0) / 100.0
            val  = self._clamp(val + trim)

            self.channels[i] = val

        # ── 3. Mixing (runs on already-processed channels) ────────────
        mixed = list(self.channels)
        for mix in model.get("mixing", []):
            src    = mix.get("source", 0)
            dst    = mix.get("destination", 0)
            weight = mix.get("weight", 0) / 100.0
            offset = mix.get("offset", 0) / 100.0
            if 1 <= src <= self.NUM_CHANNELS and 1 <= dst <= self.NUM_CHANNELS:
                mixed[dst - 1] = self._clamp(
                    mixed[dst - 1] + self.channels[src - 1] * weight + offset
                )
        self.channels = mixed

        # ── 4. Endpoints (final clamp) ────────────────────────────────
        for i in range(self.NUM_CHANNELS):
            k  = str(i + 1)
            ep = endpoints.get(k, {"min": -100, "max": 100})
            lo = ep.get("min", -100) / 100.0
            hi = ep.get("max",  100) / 100.0
            self.channels[i] = max(lo, min(hi, self.channels[i]))

    # ── Output helpers ────────────────────────────────────────────────

    def get_channels(self):
        """Return a copy of the current 16-channel values."""
        return list(self.channels)

    def get_channels_dict(self):
        """Return channels as {"1": val, "2": val, …} for JSON."""
        return {
            str(i + 1): round(self.channels[i], 4)
            for i in range(self.NUM_CHANNELS)
        }

    def get_channels_us(self):
        """Convert channels to servo microseconds (1000 – 2000 µs)."""
        return [int(1500 + v * 500) for v in self.channels]
