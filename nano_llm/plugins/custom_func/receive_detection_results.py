#!/usr/bin/env python3
from nano_llm import Plugin
import json
import logging

class RecDetRes(Plugin):
    OutputText = 0
    
    def __init__(self, log_message: str = "log message", drop_inputs: bool = True, **kwargs):
        """
        A plugin to receive and process OpenWord detector results.

        This plugin extracts detection results from an input JSON string and outputs the parsed results.

        Args:
            log_message (str): The string to be displayed in the log.
            drop_inputs (bool): If True, only the latest message from the input queue will be used (older messages dropped)
        """
        super().__init__(outputs=['text'], drop_inputs=drop_inputs, **kwargs)
        self.add_parameter('log_message', default=log_message)
        self.add_parameter('drop_inputs', default=drop_inputs)

    def process(self, input: str, **kwargs):
        """
        Parses and processes the detection results from an input JSON string.
        
        Args:
            input (str): A JSON-formatted string containing detection results.
        """
        logging.info(f"Log-Message: {self.log_message}")
        detection_results = json.loads(input)
        detected_items, detected_items_bbox, detected_items_conf = detection_results
        print("detected_items: ", detected_items)
        print("detected_items_bbox: ", detected_items_bbox)
        print("detected_items_conf: ", detected_items_conf)
        print("="*60)
        self.output(detection_results, RecDetRes.OutputText)

    @classmethod
    def type_hints(cls):
        return {
                'log_message': {
                    'multiline': 2
                }, 

                'drop_inputs': {
                    'options': ['true', 'false'],
                },
        }
