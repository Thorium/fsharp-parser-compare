module Sample

open System

/// A record with a member.
type Person =
    { Name: string
      Age: int }
    member this.Greeting = $"Hello, {this.Name}!"

[<Literal>]
let Threshold = 18

let adults people =
    people
    |> List.filter (fun p -> p.Age >= Threshold)
    |> List.sortBy (fun p -> p.Name)

let describe p =
    match p.Age with
    | n when n < 13 -> "child"
    | n when n < Threshold -> "teen"
    | _ -> "adult"

type Shape =
    | Circle of radius: float
    | Rect of width: float * height: float

let area = function
    | Circle r -> Math.PI * r ** 2.0
    | Rect (w, h) -> w * h

[<Measure>] type m
[<Measure>] type s

let speed (d: float<m>) (t: float<s>) : float<m/s> = d / t

let inline (|Even|Odd|) n = if n % 2 = 0 then Even else Odd

let rec loop acc = function
    | [] -> acc
    | x :: rest -> loop (acc + x) rest

let compute () = async {
    let! x = async { return 41 }
    return x + 1
}

let results =
    query {
        for x in [ 1 .. 10 ] do
        where (x % 2 = 0)
        select (x * x)
    }
