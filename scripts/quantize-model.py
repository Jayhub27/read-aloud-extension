#!/usr/bin/env python3
"""
Quantizes the Piper voice model for the extension bundle.

The text encoder, flow and duration predictor are quantized to int8 with QDQ
and per-channel scales. The HiFi-GAN vocoder (`/dec/`) is left in float32:
quantizing it adds audible high-frequency noise, while skipping it costs only
about 5 MB.

Usage:
    python scripts/quantize-model.py \
        --model /path/to/en_US-ljspeech-medium.onnx \
        --calibration /path/to/phoneme-ids.json \
        --output vendor/piper/en_US-ljspeech-medium.onnx

`phoneme-ids.json` is a JSON array of arrays of phoneme IDs, one array per
calibration sentence. The 12 sentences used for the committed model come from
the extension's test page and cover short, long, quoted and numeric text.

Requires:
    pip install onnxruntime onnx numpy
"""
import argparse
import json

import numpy as np
import onnx
from onnxruntime.quantization import (
    CalibrationDataReader,
    CalibrationMethod,
    QuantFormat,
    QuantType,
    quantize_static,
)


class PhonemeReader(CalibrationDataReader):
    def __init__(self, sequences):
        self.data = iter(
            [
                {
                    "input": np.array(sequence, dtype=np.int64).reshape(1, -1),
                    "input_lengths": np.array([len(sequence)], dtype=np.int64),
                    "scales": np.array([0.667, 1.0, 0.8], dtype=np.float32),
                }
                for sequence in sequences
            ]
        )

    def get_next(self):
        return next(self.data, None)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True, help="Full-precision ONNX model")
    parser.add_argument("--calibration", required=True, help="JSON array of phoneme ID arrays")
    parser.add_argument("--output", required=True, help="Where to write the quantized model")
    args = parser.parse_args()

    with open(args.calibration, encoding="utf-8") as handle:
        sequences = json.load(handle)

    graph = onnx.load(args.model)
    decoder_nodes = [
        node.name
        for node in graph.graph.node
        if node.op_type in ("Conv", "ConvTranspose") and node.name.startswith("/dec/")
    ]

    quantize_static(
        args.model,
        args.output,
        PhonemeReader(sequences),
        quant_format=QuantFormat.QDQ,
        per_channel=True,
        reduce_range=False,
        activation_type=QuantType.QUInt8,
        weight_type=QuantType.QInt8,
        op_types_to_quantize=["Conv", "ConvTranspose"],
        nodes_to_exclude=decoder_nodes,
        calibrate_method=CalibrationMethod.MinMax,
    )
    print(f"Wrote {args.output} (excluded {len(decoder_nodes)} decoder nodes)")


if __name__ == "__main__":
    main()
