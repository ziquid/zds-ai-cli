---
name: read_xlsx.py
purpose: read and display Excel spreadsheet contents
invocation: read_xlsx.py <filename.xlsx> [--sheet <name>] [--list-sheets] [--csv] [--json]
audience: agents
relevance: when reading data from Excel files
---

# read-xlsx

Read an Excel (.xlsx) file and display its contents as formatted text.  Supports selecting specific sheets and outputting in CSV or JSON format.

## USAGE

`read_xlsx.py <filename.xlsx> [--sheet <name>] [--list-sheets] [--csv] [--json]`

- `<filename.xlsx>`: path to the Excel file (required)
- `--sheet <name>`: read a specific sheet by name (default: active sheet)
- `--list-sheets`: list all available sheet names and exit
- `--csv`: output in CSV format
- `--json`: output in JSON format

## EXAMPLES

1. `read_xlsx.py data.xlsx`: display the active sheet
2. `read_xlsx.py data.xlsx --list-sheets`: list all sheets
3. `read_xlsx.py data.xlsx --sheet "Sales Data"`: read a specific sheet
4. `read_xlsx.py data.xlsx --json`: output as JSON

## PREREQUISITES

- Python 3
- openpyxl package

## EXIT CODES

- `0`: success
- `1`: failure (file not found, invalid format, missing sheet)
