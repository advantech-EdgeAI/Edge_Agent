#!/bin/bash

CHROM_F=/snap/bin/chromium
if [ ! -f $CHROM_F ];
then
    sudo apt install snap
    sudo snap install chromium
fi

$CHROM_F https://localhost:8050 >/dev/null 2>&1 &


