{
  description = "aint — minimal single-user AI chat service";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }: {
    # Expose the module so other flakes can consume it
    nixosModules.default = import ./aint.nix;
  };
}
