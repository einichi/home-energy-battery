# To-do and Known Issues

- Do something about discharge limit data not being available during backup mode
- Add an IP address and subnet selector for auto-discovery, as it seems difficult to infer the actual local network from a Docker container
- Restart service when IP addresses are configured, currently the Docker container needs restarting to kick it into action
- Switch to proper timestamped graphs with mouseover actions that show you exact data points
- Implement user-configurable trimming of collected data
- Move cost-saving calculations from daily calculations, to calculations that match the date/time range selector
- Implement automatic profile switching away from "backup" with either Grid Import / House Demand values and breaker amperage used as conditions, in order to prevent breaker tripping during "backup" mode battery charging - consider logic for automatically restoring the previous mode once demand lowers to a point where battery charging will not trip the breaker
- Add timerange electricity rates to support electric plans that have more than one off-peak price during a single day
