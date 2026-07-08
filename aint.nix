{ config, lib, pkgs, ... }:

with lib;

let
  cfg = config.services.aint;

  # Copy all static + server files into the Nix store at build time.
  # The ./ paths are relative to this .nix file, so the whole repo
  # can live anywhere and Nix will find the files correctly.
  aintPkg = pkgs.runCommand "aint" {} ''
    mkdir -p $out/static
    cp ${./server.py}   $out/server.py
    cp ${./index.html}  $out/static/index.html
    cp ${./style.css}   $out/static/style.css
    cp ${./main.js}     $out/static/main.js
  '';
in
{
  options.services.aint = {
    enable = mkEnableOption "aint single-user AI chat server";

    port = mkOption {
      type        = types.port;
      default     = 4137;           # 4=A 1=I 3=N 7=T
      description = "TCP port aint listens on.";
    };
  };

  config = mkIf cfg.enable {
    systemd.services.aint = {
      description = "aint — minimal single-user AI chat";
      wantedBy    = [ "multi-user.target" ];
      after       = [ "network.target" ];

      serviceConfig = {
        ExecStart = "${pkgs.python3}/bin/python3 ${aintPkg}/server.py";

        Environment = [
          "PORT=${toString cfg.port}"
          "DATA_DIR=/var/lib/aint"
          "STATIC_DIR=${aintPkg}/static"
        ];

        # systemd creates and owns /var/lib/aint; no manual mkdir needed.
        StateDirectory = "aint";

        # Ephemeral user/group; no /home, no login shell, minimal attack surface.
        DynamicUser = true;

        Restart    = "on-failure";
        RestartSec = "3s";
      };
    };
  };
}
